# S3 — Decoder port and pure processor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each source kind is read by a decoder behind a `SourceDecoder` port. The decoder is chosen by `inspect` at upload. In the worker the stored `original.format` picks the decoder to try first, and the bytes are probed when that format is unknown or wrong. A task decodes its source once, at the largest size its previews need; it resizes each size once and encodes each format from that size. `#generatePreviews` is replaced by small steps that touch no port.

**Architecture:**
- **The port.** `src/contracts/decoder.ts` declares `SourceDecoder` with `formats`, `inspect(bytes, limits) → SourceInfo` and `render(bytes, box, opts) → Raster`. A `Raster` is raw 8-bit sRGB pixels plus their size.
- **The decoders.** `SharpDecoder` (`src/decoders/sharp.ts`) reads raster formats with shrink-on-load. `SvgDecoder` (`src/decoders/svg.ts`) wraps the existing child-process render. `DecoderSet` (`src/decoderSet.ts`) puts a host's `decoders` in front of the two built-in ones, probes them in order at upload, and in the worker tries the stored format's decoder first, probing when no decoder lists that format or its decoder refuses the bytes.
- **The pure steps.** `src/plan.ts` turns a `SourceInfo` and the requested variants into `VariantPlan`s (output size, crop or not, sharpening, animation, identity) and computes the decode box and the frame count. `src/render.ts` holds the Sharp work and no port: `straightAlpha` once on the decoded raster, `runBeforeSteps` and `reduceToBox` once when the pipeline has `beforeSteps`, `renderSize` once per size, and `encodeVariant` per format (`variantSteps → flatten → encode`). `src/raster.ts` is the boundary between a `Raster` and Sharp: the raster check, the raw input options, and the exported helpers `rasterToSharp` and `sharpToRaster`.
- **Sharp stays replaceable.** Host code in `beforeSteps` receives and returns a `Raster`, never a Sharp object. Sharp is imported only by `decoders/sharp.ts`, `decoders/svg.ts`, the SVG helpers, `raster.ts`, `render.ts`, `worker.ts` (its tuning) and, as a type for `variantSteps`, `contracts/pipeline.ts`, so a later engine port can be cut there.
- **The services.** `PreviewRecorder` (`src/previewRecorder.ts`) owns the persist reconciliation. The `Processor` runs load → identify → plan → decode → `beforeSteps` → per-size render → per-format encode and upload → record → observers. The `Uploader` calls only `inspect`.

**Tech Stack:** Node ≥ 24 (measured on 26.12.1, Apple M1 × 8), TypeScript 7 (`erasableSyntaxOnly`, `verbatimModuleSyntax`, ESM, `.ts` specifiers), `node:test`, Biome 2.6, sharp 0.35.5 (libvips 8.18.7), mongoose 9 and mongodb-memory-server (tests only).

**Spec:** docs/design/2026-10-26-reference-architecture.md (F4; the `Uploader` and `Processor` rows of F5; "What is wrong today" item 1; Unchanged; the S3 row of Phases; the S3 open question)

## Decisions

Each one is explained for the owner in `s3-plan-decisions.md` (scratchpad). Measurements were taken on the planning machine with a 24 MP (6000×4000) photo-like JPEG, three sizes (fit → 1800×1200, 620w, 300×300) and three formats. The machine was busy (load average 14–26), so the figures are medians of interleaved runs.

- **D1. The `Raster` is raw pixels:** `{ data: Buffer; info: RasterInfo }`, 8-bit, sRGB, upright (display orientation), with frames stacked top to bottom.
  - A Sharp instance cannot share its decoded pixels: `clone()` decodes again for every clone, which is today's bug.
  - A raw raster is what any decoder can produce. Wrapping one and reading it back cost 5–13 ms at the 1800×1200 box and 26–112 ms at the full 24 MP, against 179–260 ms for the decode itself.
  - `info.premultiplied` is set only by a decoder whose bytes really are premultiplied. Sharp reports `premultiplied: true` on raw output after a resize although the bytes are not premultiplied, and forwarding that flag turned the pixel (99,49,199) into (197,97,255).
  - **Premultiplied rasters are converted once.** The Processor calls `straightAlpha` right after `checkRaster`: a raster marked `premultiplied` goes through Sharp once (`sharp(data, rasterInput(raster, limits)).raw()`) and comes back as straight alpha, unmarked. Every later step (`runBeforeSteps`, `renderSize` and its shortcut, `encodeVariant`) therefore works on straight alpha and never forwards a flag. Measured: Sharp already unpremultiplies raw input marked premultiplied on any output, even with no operation ((50,25,100,128) → (99,49,199,128)); the explicit step keeps the core independent of that.
- **D2. `beforeSteps` receive the decoded first frame as a `Raster` and return a `Raster`** (breaking; engine-neutral):
  ```ts
  type BeforeStep = (raster: Raster, meta: { media: MediaLike; source: SourceInfo; scale: number; ctx: Record<string, unknown> }) => Raster | Promise<Raster>;
  ```
  - **Why a `Raster` and not a Sharp object.** Sharp is only the current engine; another engine may do better on large volumes in some deployments. A host-facing step API that is a Sharp object would tie every host's code to Sharp. The step sees pixels (raw 8-bit sRGB, upright, the shape the decoders produce), so the engine stays replaceable. The core never hands a Sharp instance to host code in `beforeSteps`.
  - **The helpers keep a Sharp-based step to one line.** The main entry exports two functions from `src/raster.ts`:
    - `rasterToSharp(raster: Raster): Sharp` is `sharp(raster.data, { raw: { width, height: height × frames, channels, pageHeight when frames > 1, premultiplied when true }, limitInputPixels: width × height × frames })`. The raster is already in memory, so its own size is the input limit (the helper has no config to read `limits.inputPixels` from, unlike the core's `rasterInput`), and raw input carries no decoder warnings, so `failOn` does not apply; what a step returns is checked by the core.
    - `sharpToRaster(img: Sharp): Promise<Raster>` reads back `img.toColorspace('srgb').raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })` as `{ data, info: { width, height, channels } }`. It never forwards Sharp's `premultiplied` flag (D1), and rejects a multi-page result with `ResizeSetupError` `RESIZE_PIPELINE_STEP_INVALID`.
    - Example: `beforeSteps: [async (r) => sharpToRaster(rasterToSharp(r).blur(5))]`.
  - A step therefore never decodes or encodes, and SVG markup never reaches it.
  - Keeping today's `Buffer` would cost a lossless encode and decode of the whole image per task (seconds at 24 MP), or would hand the steps the original bytes instead of the decoded raster.
  - **The core checks what a step returns.** It is `ResizeSetupError` `RESIZE_PIPELINE_STEP_INVALID` unless it is a `Raster`: `data` is a `Buffer`; `width`, `height` and `channels` are positive integers; `channels` is 1–4; `data.length === width × height × channels × frames`; and `frames` is absent or 1. A `Buffer` (today's form) and a Sharp instance are both refused. A returned raster marked `premultiplied: true` goes through `straightAlpha`, like a decoder's (D1).
  - **What an old step does now** (measured): `async (buf) => sharp(buf).blur(5).toBuffer()` receives a `Raster` object, which Sharp reads as constructor options, so the step itself rejects with Sharp's plain `Error` "Input file is missing" before the core sees a result. The task is retried, then dead-lettered; eager `generate()` throws that error. `RESIZE_PIPELINE_STEP_INVALID` is what a step gets when it resolves with something else, such as a `Buffer` built without `sharp(buf)` or a Sharp instance.
  - **Coordinates.** With `beforeSteps`, the decoder renders at least the source's own size, and only its first frame.
    - For a raster source the steps see the upright original at its own size (a raster is never enlarged), so coordinates a host stored for the original stay valid, as today.
    - For a vector source (SVG, or a host's PDF decoder) the pixels can be larger: the box grows with the largest preview, as today's SVG render does.
    - `meta.scale` is the width of the pixels the step receives divided by `source.width`: 1 for a raster source, 100 for a 20×10 SVG rendered at 2000×1000. A step multiplies coordinates stored in the source's units by it once, and works for every source kind. It is additive.
    - Decoding at the box with `beforeSteps` (cheaper, but a crop step loses resolution) is left to a later phase as a per-pipeline opt-in (see Follow-ups).
  - **Memory.** The full-size decode is held as a Node `Buffer`. While a step runs, its input and its output both exist, so the peak is about 2 × width × height × 4 bytes (3 for an opaque source): at the default `limits.sourcePixels` (50 MP), up to 400 MB.
    - The Processor keeps no other reference to the raster it hands to `runBeforeSteps`, and `runBeforeSteps` keeps only the current one, so a step's input is dropped as soon as the step resolves (unless the host's step keeps it).
    - After the last step, the Processor reduces the raster once to the re-planned decode box (`reduceToBox`). The sizes are then rendered from that box, not each from the full-size raster.
    - Without `beforeSteps` the decoder renders at the box, so only the box is held.
  - **The pixel budget after the steps** is checked on the returned raster's dimensions; no read-back is needed. A step that grows the image has therefore already allocated it when the check rejects it. Today it was checked on the header of the step's encoded result. Steps are host code; the docs say so (Task 10).
  - `meta.metadata` (Sharp metadata of the bytes) becomes `meta.source` (the `SourceInfo`).
- **D3. `upload.formats` stays the allowlist.**
  - An upload is accepted only when a decoder identifies the bytes AND the format it reports is listed in `upload.formats`.
  - A `pdf` decoder without `'pdf'` in `upload.formats` is `RESIZE_ORIGINAL_FORMAT_DISABLED`, and nothing is stored.
  - The worker does not read `upload.formats` (it does not today either); it needs a decoder for the stored format.
- **D4. Where each limit and rule lives.** Codes and `retryable` values are today's unless this list says otherwise.

  | Rule | Lives in | Code (`retryable`) |
  |---|---|---|
  | Format, display size, pages, whether it animates | decoder `inspect` | — |
  | No width or height | decoder `inspect` | `RESIZE_SOURCE_METADATA_MISSING` (false); the `Uploader` reports it as `RESIZE_ORIGINAL_METADATA_MISSING`, as today |
  | `limits.inputPixels` | every Sharp call (decoders, `render.ts`) | Sharp's error, wrapped as `RESIZE_SOURCE_DECODE_FAILED` at decode (retried, as today); Sharp's own error elsewhere |
  | `limits.sourcePixels`, all frames, at upload | `Uploader` | `RESIZE_ORIGINAL_TOO_MANY_PIXELS` |
  | `limits.sourcePixels` for SVG, before the density probe (today's order, D14) | `SvgDecoder.inspect`, on Sharp's size | `RESIZE_SOURCE_TOO_LARGE` (false); the `Uploader` reports it as `RESIZE_ORIGINAL_TOO_MANY_PIXELS` |
  | `limits.sourcePixels`, one frame, in the worker | `Processor`, after `inspect` | `RESIZE_SOURCE_TOO_LARGE` (false) |
  | The pixel budget after `beforeSteps`, on the returned raster's dimensions | `Processor` | `RESIZE_SOURCE_TOO_LARGE` (false), "processed source exceeds pixel limits" |
  | `maxSize`, `limits.resultDimension`, the own-size rule, derived sides, sharpening | `planVariants` | — |
  | `animated`, `limits.animationFrames`, the frames that fit the budget | `planVariants` and `framesToDecode` | — |
  | `limits.processingTimeoutSeconds` | `.timeout()` on every Sharp call; the SVG child is killed | `RESIZE_SVG_RENDER_TIMEOUT` (false) for SVG |
  | SVG dimensions | `SvgDecoder.inspect`: at upload, and in the worker before any render or step; again in `render` | `RESIZE_SVG_DIMENSIONS_UNSUPPORTED` (false) |
  | The SVG render | `SvgDecoder.render`, through `rasterizeSvg` | `RESIZE_SVG_RENDER_TIMEOUT` (false), `_FAILED`, `_UNAVAILABLE` (both retryable) |
  | Unconfigured format in a task payload | `Processor`, before the download | `RESIZE_FORMAT_NOT_CONFIGURED`, that variant fails |
  | An SVG output | `encodeVariant` | `RESIZE_SVG_PUBLIC_PREVIEW` |

  - **A decoder's `render` rejection fails the task, or `generate()`, with the decoder's own error, before any upload.** This is today's SVG rule, now for every source. Today a raster that failed to decode failed every variant, and the task failed with `RESIZE_WORKER_INCOMPLETE`. The retry behaviour stays the same: a Sharp error is retried, and a `ResizeError` keeps its `retryable`.
  - **The worker adds the media id, and every decode failure is a `ResizeError`.** The `Processor` passes each rejection of `identify`, `render` and `straightAlpha` through `sourceError(err, mediaId)`:
    - A decoder's `ResizeMediaError` has no media id, because the port has none. It is rethrown as a `ResizeMediaError` with `mediaId`, the same code and `retryable`, and the original error as `cause`.
    - A `ResizeSetupError` (such as `RESIZE_SVG_RENDER_UNAVAILABLE` or `RESIZE_DECODER_MISSING`) passes through unchanged.
    - An error that is not a `ResizeError` (Sharp's own error for a corrupt file, or for an HEVC-coded HEIC that `upload.formats` accepted and prebuilt libheif cannot decode, or a host decoder's plain `Error`) becomes a `ResizeMediaError` `RESIZE_SOURCE_DECODE_FAILED`, retryable, with `mediaId` and the original error as `cause`. Eager `generate()` therefore still throws a `ResizeError`, as AGENTS.md promises, and the retry behaviour is today's (such an error was retried, and still is).
- **D5. A repeatable benchmark, `bench/renderOnce.ts`** (Task 9), run by hand: `node --experimental-strip-types bench/renderOnce.ts [rounds] [--single-thread]`.
  - It is not matched by `node --test`, is outside `types:check`, and is kept Biome-clean (Biome lints `**`).
  - **The paths**, on a generated 24 MP JPEG with three sizes and the package's default encoder settings, in one process:
    1. a copy of today's per-variant loop (`clone()` per variant), for information;
    2. "resize once per size": one decode and resize per size, then each format encoded from those raw pixels. Its per-size operations are exactly path 3's: the sizes come from `planVariants`, and each is `rotate()` → `resize(width, height, { fit: mode, position: 'center' })` → `toColorspace('srgb')` → `sharpen()` when the plan sharpens → raw;
    3. the new path, through the real `Resizer.generate()`;
    - 2′, a second copy of path 2 in the same round, as an A/A control.
  - **The gate set is the three sizes × `jpeg` and `webp`.** AVIF encoding is the same work in paths 2 and 3, dominates CPU time (about 5.7 of 6.5 s) and only adds variance.
  - **Rounds.** One warm-up round is discarded, then at least 9 rounds (the default), with the path order rotating each round. Each round gives paired ratios `r = path 3 / path 2` for wall and for CPU time, and the A/A ratio `a = path 2′ / path 2`.
  - **Verdict, checked in this order** (a noisy machine never yields a `PASS`):
    1. `INCONCLUSIVE` (exit code 2, "rerun on a quieter machine") when the A/A spread exceeds 0.05 for wall or for CPU. The spread is the largest `|a − 1|` over the rounds left after sorting the `n` A/A ratios and dropping `floor(n / 4)` at each end (9 rounds keep the middle 5);
    2. `PASS` (exit code 0) when the median of `r` is at most 1.05 for wall and for CPU;
    3. `FAIL` (exit code 1) otherwise.
  - **For the record, not the verdict:**
    - the AVIF set (jpeg, webp and avif) runs once more, 3 rounds of paths 1, 2 and 3, medians printed;
    - the peak RSS of each path, each measured in its own child process (`process.resourceUsage().maxRSS`, since one process's peak only grows), plus path 3 with one `beforeStep` that returns its input (the D2 memory bound);
    - the spec's absolute reading, 3535 ms.
  - `--single-thread` (optional) sets `sharp.concurrency(1)` and concurrency 1 in every path, so CPU time reflects work rather than thread contention. The same rule applies.
  - **Planning run** (the first-round rule, on a machine with load 14–26 on 8 cores). CPU medians of paths 1 / 2 / 3: without AVIF, 1205 / 792 / 741 ms; with AVIF, 7280 / 6489 / 6895 ms. Wall medians with AVIF: 3003 / 2807 / 2867 ms. The CPU ratio with AVIF (1.063) shows why AVIF is out of the gate: without AVIF the new path is cheaper.
  - **The spec's absolute reading** ("3 sizes × 3 formats on a 24 MP source not slower than 3535 ms") was met in the planning run: 2867 ms wall. The gate is the relative rule, because 3535 ms was measured on another machine.
- **D6. Task order keeps every commit green.**
  1. The port, `SharpDecoder` and `DecoderSet` (Task 1), then `SvgDecoder` (Task 2), with nothing wired in yet.
  2. The pure plan (Task 3), then the Sharp steps (Task 4).
  3. The persist step moves out unchanged (Task 5).
  4. The Processor runs on the new pieces, and `#generatePreviews` is deleted (Task 6).
  5. The Uploader moves to `inspect` (Task 7).
  6. The `decoders` option and the test-only `pdf` decoder end to end (Task 8).
  7. The benchmark (Task 9), then the docs (Task 10).
- **D7. No renames.** `src/helpers/svgRaster.ts`, `svgRasterChild.ts` and `svgDimensions.ts` stay where they are: AGENTS.md tells bundlers to keep `svgRasterChild.js` next to `svgRaster.js`. S3 only creates files, so the S1 rule "a pure `git mv` commit first" does not come up.
- **D8. Choosing a decoder.**
  - Order: `[...options.decoders, SharpDecoder, SvgDecoder]`. A host decoder can take over a built-in format, and a raster upload is parsed once.
  - At upload, each `inspect` either accepts the bytes or refuses them with `RESIZE_SOURCE_FORMAT_UNSUPPORTED`. A refusal moves on to the next decoder; any other rejection is final.
  - **In the worker, the stored `original.format` only picks the decoder to try first** (a policy, host-visible). Today the worker never reads `original.format`; it sniffs the bytes.
    - The first decoder that lists the stored format inspects the bytes. If it accepts, it renders. Any rejection other than a refusal is final.
    - If no decoder lists the stored format (an alias such as `'jpg'`, a MIME type, or a format whose decoder this process lacks), or its decoder refuses the bytes, the worker probes the other decoders, as for a record without a format; the refusing decoder is not asked again. When the probe finds a decoder, the worker logs one warning per task naming the stored and the detected format, and renders.
    - Only when the probe also finds no decoder (every decoder refuses, or one rejects with an error that is not a `ResizeError`, which is how Sharp reports bytes it cannot read):
      - `ResizeSetupError` `RESIZE_DECODER_MISSING` (retryable: a worker deployed with that decoder can run the task) when the stored format is a non-empty string that no decoder lists. The probe's error is its `cause`, and that error's message is part of its own message, because the task row keeps only `String(error)`;
      - otherwise `RESIZE_SOURCE_FORMAT_UNSUPPORTED`, `retryable: false`, when every decoder refused; a plain error is rethrown, and the Processor reports it as `RESIZE_SOURCE_DECODE_FAILED` (D4).
    - A `ResizeError` from a probed decoder (such as `RESIZE_SVG_DIMENSIONS_UNSUPPORTED`) is rethrown in every case: that decoder recognised its format.
    - A record without a stored format (written before formats were stored, and most test fixtures) is probed with no warning. Only a non-empty string counts as a stored format.
  - **Why a fallback and not a refusal.** `docs/host-adoption.md` tells hosts to map their legacy data into `original`, so a guessed format is the adoption path; such a record renders today and keeps rendering, with a warning to fix it. SVG markup still never reaches the in-process render: `SharpDecoder.inspect` refuses SVG, so an original stored as `'png'` that holds SVG markup is probed and rendered by `SvgDecoder` in its child process.
- **D9. One decode at the largest box; the plan fixes every output size.**
  - The decode box is the largest scale any plan needs, computed from the capped output sizes, not from the requested ones. A raster is never enlarged; a vector source may be.
  - Each size is resized once, from that raster, to the exact width and height of its plan: `fill` when the source's aspect ratio is kept, `cover` when it is cropped.
  - Smaller sizes are made from the box raster. Measured against a full-decode reference, the 620-wide preview scores 51.3 dB this way, and 43.6 dB through today's direct shrink-on-load path.
  - Because the plan sets every side, the derived side of a raster `fit` or width-only preview can differ by one pixel from the release candidate, where Sharp rounded it. SVG sizes already came from the same arithmetic.
- **D10. Animation.**
  - A preview keeps the frames only in an animated format (`webp`, `gif`), only with `animated: true`, and only in a pipeline with neither `beforeSteps` nor `variantSteps`. Before, `beforeSteps` did not prevent it.
  - The raster carries the frame `delay`s and the `loop` count: an animation encoded from raw pixels without them plays at the encoder's default speed and loops once.
  - `renderSize` resizes frame by frame. Sharp does not resize a raw multi-page image per frame: the page height goes stale and the encode fails.
  - **Memory.** An animated source is held as `frames × box × channels` bytes. `framesToDecode` keeps `frames × width × height` within `min(sourcePixels, inputPixels)`, so at the default 50 MP that is at most about 200 MB (RGBA). Each animated size being rendered adds one stacked copy at its own size; `SizedRasters` drops it after its last variant.
- **D11. `variantSteps` receive a Sharp instance over the sized pixels** instead of a pending resize on the source. `img.metadata()` now reports the preview's size and format `'raw'`, and a step's own `.resize()` resizes the preview instead of replacing the core's resize. Every operation a step adds now runs on the sized pixels, including ones Sharp would otherwise apply before its resize: `img.trim()` used to trim the source and now trims the preview. Steps that only `composite()` are unaffected.
- **D12. Exports.** The main entry adds the `SourceDecoder` class, the helpers `rasterToSharp` and `sharpToRaster` (from `src/raster.ts`, D2), and the types `SourceInfo`, `Raster`, `RasterInfo`, `DecodeBox`, `RenderOptions` and `ResizeLimits`. `SharpDecoder`, `SvgDecoder` and `DecoderSet` stay internal: every Resizer appends the built-in decoders itself.
- **D13. Additions to the F4 signature.** Each is additive, and a decoder may ignore it:
  - `render`'s options carry `source` (what `inspect` returned) and `frames` (how many frames to decode), besides `limits` and `signal`;
  - `SourceInfo` has `vector` (no own-size rule; the box may exceed the natural size);
  - `RasterInfo` has `frames`, `delay`, `loop` and `premultiplied`;
  - the port has an optional `verify()`, like every other port;
  - `planVariants` takes `PlanRules`, built from the config, the pipeline and the preview scope, because the own-size rule depends on the pipeline and the identities depend on the scope.
- **D14. The SVG upload order stays today's.** `SvgDecoder.inspect` checks `limits.sourcePixels` on Sharp's size before the density probe, so an SVG over both the pixel limit and the renderer's side limit still reports `RESIZE_ORIGINAL_TOO_MANY_PIXELS`, not `RESIZE_SVG_DIMENSIONS_UNSUPPORTED`.

## Global Constraints

- **Branch and repository.**
  - Work on branch `refactor/s3-decoder-port` in the worktree `.claude/worktrees/s1-ports-and-composition-root`, on top of `main` at `dbc9780` (S1, S2 and the docs round merged).
  - Each task ends with one commit. Nothing is pushed, including the docs-site branch `docs/s3-decoder`.
  - Use plain git in the worktree, never `git -C` and no compound git commands. The docs-site step runs from inside that repository.
- **Scope.** F4 only. Out of scope:
  - F6 (named queues);
  - F7 (the config factory);
  - F8 (metrics: the `metrics` dependency of the `Uploader` and the `Processor` waits for S5, and today's log lines stay);
  - F9 (freshness);
  - S6 hygiene.
- **Unchanged.**
  - The preview identity string and random preview keys (`previews/<hex>.<ext>`, `originals/<hex>.<ext>`).
  - The SVG policy: private, never served, rendered once per task in a child process. The private-original policy.
  - The S2 gate and coordination, and the lease-token fencing.
  - `resolve()` never throws and never runs Sharp.
  - `appendPreviews` as one guarded write per row, with the same reconciliation and log lines.
  - The hooks; `Pipeline` keeps its two lists.
- **Per-variant errors keep their meaning.** A variant whose `variantSteps`, encode or upload fails counts as failed and is logged as `resize worker: variant ${identity} failed for media ${mediaId}`. The task then fails with the retryable `RESIZE_WORKER_INCOMPLETE`. A size whose `renderSize` rejects fails each of its variants the same way. A decoder rejection is not a variant failure (D4).
- **Error codes.**
  - New:
    - `RESIZE_SOURCE_FORMAT_UNSUPPORTED` (`ResizeMediaError`): a decoder refuses bytes that are not its format. The shipped decoders set `retryable: false`. `DecoderSet` also throws it, `retryable: false`, when every decoder refuses the bytes (D8).
    - `RESIZE_DECODER_MISSING` (`ResizeSetupError`, retryable): no decoder in this process lists the stored format, and none reads the bytes.
    - `RESIZE_DECODER_INVALID` (`ResizeSetupError`): a `decoders` entry is not a decoder (at construction), or a decoder broke the contract (its `inspect` result or its raster).
    - `RESIZE_PIPELINE_STEP_INVALID` (`ResizeSetupError`, retryable): a `beforeStep` resolved with something that is not a one-frame `Raster` (a `Buffer`, a Sharp instance, a malformed or multi-frame raster), or `sharpToRaster` was given a multi-page image.
    - `RESIZE_SOURCE_DECODE_FAILED` (`ResizeMediaError`, retryable): `identify`, a decoder's `render`, or `straightAlpha` rejected in the worker or in `generate()` with an error that is not a `ResizeError`; the original error is the `cause` (D4).
  - Renamed: none. Removed: none.
  - Changed meaning: `RESIZE_ORIGINAL_FORMAT_UNSUPPORTED` now means "no decoder reads these bytes"; before, it meant "Sharp named no format". It fires when Sharp identifies a format no decoder lists (a libvips build with extra loaders), or when every decoder refuses the bytes. Bytes Sharp cannot read at all stay `RESIZE_ORIGINAL_INVALID`, as today: Sharp's own error is not a refusal.
  - Same code and `retryable`, new place: `RESIZE_SOURCE_METADATA_MISSING`, `RESIZE_SVG_DIMENSIONS_UNSUPPORTED`, `RESIZE_SVG_RENDER_*` and, for SVG, `RESIZE_SOURCE_TOO_LARGE` (D14) are thrown inside the decoders. The worker adds the media id (D4).
- **Main-entry exports (D12).** New values: `SourceDecoder` (Task 1), `rasterToSharp` and `sharpToRaster` (from `src/raster.ts`, exported in Task 6). New types: `SourceInfo`, `Raster`, `RasterInfo`, `DecodeBox`, `RenderOptions`, `ResizeLimits`. The helpers live in `src/raster.ts`, not in `types.d.ts`, which stays dependency-free.
- **Host-visible changes**, each in Task 10:
  - the `decoders` option and the exports of D12, including the helpers `rasterToSharp` and `sharpToRaster`;
  - the `BeforeStep` signature (a `Raster` in, a `Raster` out), `meta.scale` and what coordinates refer to (D2);
  - what `variantSteps` receive, including operations Sharp used to apply before its resize (D11);
  - animation stops with `beforeSteps` (D10);
  - the memory a worker holds with `beforeSteps` and for animations (D2, D10);
  - decode failures fail the task with the decoder's error, or `RESIZE_SOURCE_DECODE_FAILED` (D4);
  - the worker reads `original.format` to pick the decoder to try first; a mismatch is logged and the bytes are probed (D8);
  - the new codes and the changed meaning above;
  - the one-pixel rounding note (D9).
- **Pre-release.** Breaking changes ship without migration code.
- **House rules from S1.**
  - Classes own their behaviour. Module-private helpers take narrow parameters, never a whole deps bag.
  - No service imports `resizer.ts`.
  - `drivers/**` import only contracts, errors, helpers, types and other drivers.
  - Shipped code never uses `instanceof` on errors; it uses the `isResizeError` brand.
  - No test-only seams in shipped code.
  - No `any`, except with a `biome-ignore` that gives the reason.
  - `src/types.d.ts` stays dependency-free.
  - Comments state reasons in plain words, with no spec-section references and no private project names.
  - Tests never spread class-typed values; write the object out.
- **Also for S3.**
  - `src/decoders/**` import only contracts, errors, helpers, types and other decoders, plus `sharp` and Node built-ins.
  - `plan.ts` imports no `sharp` and no port; `plan.ts`, `raster.ts` and `render.ts` reach no storage, media, task-queue or lock contract (guarded in Tasks 3 and 4).
  - Only an explicit allowlist of shipped files imports `sharp` (guarded from Task 4, final in Task 7): `contracts/pipeline.ts` (the `Sharp` type of `variantSteps`), `decoders/sharp.ts`, `decoders/svg.ts`, `helpers/svgDimensions.ts`, `helpers/svgRasterChild.ts`, `raster.ts`, `render.ts` and `worker.ts`. The Uploader, `plan.ts`, the Processor and the other services do not.
  - Host code in `beforeSteps` never receives a Sharp instance (D2).
  - No shipped file checks `instanceof` on a decoder or on a Sharp instance; use duck typing, because a host may bring its own copy of the package or of sharp.
- **Checks.**
  - Every task ends with `npm run types:check`, `npm run check` and `npm test` passing.
  - Tasks 1, 6, 8 and 10 also run `npm run build && npm run smoke`.
  - One file: `node --experimental-strip-types --test src/<file>.test.ts`.
  - Test files are outside `types:check` (about 65 errors already exist there); add none.
- **Commit messages** use a conventional prefix, with NO `Co-Authored-By` and no "Generated with" trailer.

## Review Focus

1. **An animated source keeps its timing.** Raw pixels hold no frame delays. Unless the raster carries `delay` and `loop` to the encoder, every animated WebP or GIF preview plays at the encoder's default speed and loops once (measured: WebP delay 100 per frame and loop 1, GIF delay 0). Expected: the preview's `delay` and `loop` equal the source's. (Test: Tasks 1, 4 and 6.)
2. **A semi-transparent source keeps its colours.** Sharp marks raw output `premultiplied: true` after a resize although the bytes are not premultiplied. A renderer that forwards the flag doubles the colour of every half-transparent pixel; one that ignores a decoder's real premultiplied bytes halves it. Expected: an (100,50,200,α 128) source gives that pixel back within ±2. (Tests: Task 1, `SharpDecoder.render` at a resizing box; Task 4, `renderSize` with encode, `straightAlpha` and `sharpToRaster`; Task 6, `runBeforeSteps` (a step through the helpers, and a step that returns premultiplied pixels) and a decoder that returns premultiplied pixels.)
3. **A stored format that does not match the bytes.** `original.format: 'png'` on SVG markup (a bug, a tampered record, or a host's guess) must never be parsed for rendering in-process. Expected: the preview is rendered by `SvgDecoder` in its child process (`countRenders() === 1`), the in-process decoder never renders, and one warning names `'png'` and `'svg'`. (Test: Task 6.)
4. **A decoder whose render rejects.** Expected: the whole task fails before any upload, with the decoder's code and `retryable` and the media id. It does not count as N failed variants, and eager `generate()` throws that error, not `ResizeGenerateError`. (Test: Task 6.)
5. **A requested box beyond `limits.resultDimension`.** A 9000×9000 request on a 100×100 SVG must render the raster for the capped 5000×5000 preview. Today the SVG density follows the uncapped request, limited only by the pixel budget: with the default 50 MP, that request renders about 7071×7071. Expected: the decoder is asked for the capped box. (Test: Tasks 3 and 6.)

---

## File structure

| File | Change | Responsibility after S3 |
|---|---|---|
| `src/contracts/decoder.ts` | Create | `SourceDecoder`, `SourceInfo`, `DecodeBox`, `RenderOptions`, `Raster`, `RasterInfo` |
| `src/decoders/sharp.ts` | Create | `SharpDecoder`: raster formats, shrink-on-load decode at the box, frames with delays and loop |
| `src/decoders/svg.ts` | Create | `SvgDecoder`: SVG natural size and dimension check; render in the child process, then raw pixels |
| `src/decoderSet.ts` | Create | `DecoderSet` (probe; try the stored format's decoder first and probe on a mismatch; check `inspect` results; `verify`), `createDecoderSet` |
| `src/plan.ts` | Create | `planRules`, `planVariants`, `decodeBox`, `framesToDecode`: sizes, crop, own size, sharpening, animation, identities |
| `src/raster.ts` | Create | The boundary between a `Raster` and Sharp: `rasterProblem`, `checkRaster`, `rasterInput`, and the exported `rasterToSharp` and `sharpToRaster` |
| `src/render.ts` | Create | `straightAlpha`, `firstFrame`, `reduceToBox`, `renderSize`, `SizedRasters`, `encodeVariant`, `runBeforeSteps` |
| `src/previewRecorder.ts` | Create | `PreviewRecorder`: one `appendPreviews` and its reconciliation (moved from the Processor) |
| `src/processor.ts` | Rewrite | `generate`, `processTask` and `notify` on the steps above; no Sharp import, no SVG branch |
| `src/uploader.ts` | Modify | `inspect` through the `DecoderSet`; the error mapping; no Sharp import |
| `src/contracts/pipeline.ts` | Modify | `BeforeStep` takes and returns a `Raster`, with `meta.source` and `meta.scale`; `VariantStep` keeps its Sharp instance |
| `src/resizer.ts` | Modify | The `decoders` option; one `DecoderSet` per Resizer, passed to the Uploader and the Processor; `verify()` calls the decoders |
| `src/types.d.ts` | Modify | `ResizeLimits`; `ResizeConfig.limits: ResizeLimits` |
| `src/index.ts`, `src/index.test.ts`, `smokeTest.ts` | Modify | The D12 exports |
| `src/testHelpers/pdfDecoder.ts` | Create | `TestPdfDecoder`, `fakePdf()`: the test-only `pdf` decoder |
| `bench/renderOnce.ts` | Create | The benchmark (D5) |
| Tests | Create / Modify | `decoders/sharp`, `decoders/svg`, `decoderSet`, `plan`, `render`, `previewRecorder`, `customDecoder` (new); `processor`, `uploader`, `resizer`, `architecture`, `importGraph` (modified) |
| `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/host-adoption.md`, docs site `docs/12-resize.md` | Modify | Decoders, the `beforeSteps` change, the new codes |

---

### Task 1: The decoder port, `ResizeLimits`, `SharpDecoder` and `DecoderSet`

**Files:**
- Modify: `src/types.d.ts:258-264` (the `limits` block becomes `ResizeLimits`).
- Create: `src/contracts/decoder.ts`, `src/decoders/sharp.ts`, `src/decoderSet.ts`.
- Modify: `src/index.ts`; `src/index.test.ts:14-38` and its constructor list; the `expected` list of `CHECK_CORE` in `smokeTest.ts:40-64`; `src/importGraph.test.ts`.
- Test: `src/decoders/sharp.test.ts`, `src/decoderSet.test.ts`.

**Interfaces:**
Produces:
```ts
// src/types.d.ts
export interface ResizeLimits { inputPixels: number; sourcePixels: number; resultDimension: number; animationFrames: number; processingTimeoutSeconds: number }
// ResizeConfig.limits: ResizeLimits (same fields, same defaults)

// src/contracts/decoder.ts
export interface SourceInfo {
  format: string;      // stored as original.format; one of the decoder's `formats`
  contentType: string; // stored as original.contentType
  width: number;       // display size of one frame; a vector source may report a fractional natural size
  height: number;
  pages?: number;      // frames in the source; absent = 1
  animated?: boolean;  // more than one frame AND renderable as an animation (Sharp: no EXIF orientation)
  vector?: boolean;    // no own size: the own-size rule is off and the box may exceed width × height
}
export interface DecodeBox { width: number; height: number }
export interface RenderOptions { limits: ResizeLimits; signal?: AbortSignal; source: SourceInfo; frames: number }
export interface RasterInfo {
  width: number; height: number;   // one frame
  channels: 1 | 2 | 3 | 4;
  frames?: number;                 // absent = 1; frames are stacked top to bottom in `data`
  delay?: number[]; loop?: number; // animation timing, kept for the encoder
  premultiplied?: boolean;         // true only when the bytes really are premultiplied
}
export interface Raster { data: Buffer; info: RasterInfo } // 8-bit, sRGB, upright
export abstract class SourceDecoder {
  abstract readonly formats: readonly string[];
  abstract inspect(bytes: Buffer, limits: ResizeLimits): Promise<SourceInfo>;
  abstract render(bytes: Buffer, box: DecodeBox, opts: RenderOptions): Promise<Raster>;
  verify?(): void | Promise<void>;
}

// src/decoders/sharp.ts
export class SharpDecoder extends SourceDecoder { readonly formats: readonly string[] }

// src/decoderSet.ts
export interface IdentifiedSource {
  decoder: SourceDecoder; info: SourceInfo;
  mismatch?: { stored: string; reason: 'unlisted' | 'refused' }; // set when a stored format was given and the probe chose
}
export class DecoderSet {
  constructor(decoders: readonly SourceDecoder[]);
  readonly decoders: readonly SourceDecoder[];
  forFormat(format: string): SourceDecoder | undefined; // the first that lists it
  identify(bytes: Buffer, limits: ResizeLimits, storedFormat?: unknown): Promise<IdentifiedSource>; // only a non-empty string counts
  verify(): Promise<void>; // each decoder's verify(), in order
}
export function createDecoderSet(extra?: unknown): DecoderSet; // validates `extra`, then appends the built-in decoders
```
**Decision (the port's contract, in its doc comments):**
- **`inspect`** reads only what it needs to measure the bytes. It never renders. When the bytes are not one of its `formats`, it rejects with `ResizeMediaError` `RESIZE_SOURCE_FORMAT_UNSUPPORTED`, quickly.
- **`render`** returns one upright 8-bit sRGB raster with `opts.frames` frames, or one frame when it cannot animate.
  - The raster is at least `box` on both sides where the decoder's limits allow; the renderer resizes to each exact size either way. A raster source smaller than the box is never enlarged. (The SVG decoder's density is a whole number and is capped by the pixel budget and librsvg's side limit, so a 100×100 SVG asked for 333×333 gives 332×332.)
  - Colours are converted to sRGB with the embedded profile, and no profile is carried.
  - It respects `limits`, and stops when `signal` aborts if it can (the SVG child is killed; a Sharp call is bounded by its timeout).
- A decoder header states the reason for the port: a new source kind needs only a new decoder.

**`SharpDecoder`:**
- **`formats`** are the `id`s of the `sharp.format` entries whose `input.buffer` is `true`, without `svg` and `raw`, plus `avif` when `heif` is present.
- **`inspect`** runs `sharp(bytes, { limitInputPixels: limits.inputPixels, animated: true }).timeout({ seconds: limits.processingTimeoutSeconds }).metadata()`. A Sharp error is rethrown unchanged.
  - The format is `'avif'` when Sharp says `heif` and `isAvifBuffer(bytes)` is true.
  - A format outside `formats` → `RESIZE_SOURCE_FORMAT_UNSUPPORTED`, `retryable: false`.
  - No width or height → `ResizeMediaError` `RESIZE_SOURCE_METADATA_MISSING`, `retryable: false`.
  - The frame height is `pageHeight ?? height`. Width and height are swapped when the EXIF orientation is 5 or more.
  - `pages` is `meta.pages ?? 1`; `animated` is `pages > 1 && orientation <= 1`; `contentType` is `` `image/${format}` ``.
- **`render`** runs:
  ```
  sharp(bytes, { failOn: 'none', sequentialRead: true, limitInputPixels, pages: frames })
    [.rotate() only when frames === 1]
    .resize(box.width, box.height, { fit: 'outside', withoutEnlargement: true })
    .toColorspace('srgb').raw({ depth: 'uchar' }).timeout(…).toBuffer({ resolveWithObject: true })
  ```
  - With `frames > 1` it reads `delay` (the first `frames` entries) and `loop` from one `metadata()` call.
  - It never copies `info.premultiplied`. It does not watch `signal`: Sharp cannot be cancelled, and `.timeout()` bounds the call.

**`DecoderSet`:**
- **The probe** asks each decoder in order. A rejection whose `code` is `RESIZE_SOURCE_FORMAT_UNSUPPORTED` (checked with `isResizeError`) is a refusal and moves on; any other rejection is rethrown. When every decoder refuses, it rejects with `RESIZE_SOURCE_FORMAT_UNSUPPORTED`, `retryable: false`, whose message names the formats tried and whose `cause` is the first refusal.
- **`identify` without a stored format** (`storedFormat` absent, or not a non-empty string) is the probe, and sets no `mismatch`.
- **`identify` with a stored format** (D8):
  1. `forFormat(storedFormat)` inspects first. If it accepts, that is the result, with no `mismatch`. A rejection other than a refusal is rethrown.
  2. Otherwise the probe runs over the other decoders (the refusing one is skipped), and its result carries `mismatch: { stored, reason }`: `'unlisted'` when no decoder lists the format, `'refused'` when its decoder refused.
  3. When the probe finds nothing and the reason is `'unlisted'`, a probe that ended with every decoder refusing, or with an error that is not a `ResizeError`, becomes `RESIZE_DECODER_MISSING`, with that error as `cause` and the message ``resize: no decoder lists format '<f>' and none reads the bytes (<the probe error's message>) — pass one in `decoders` in every process that uploads or generates previews (API and worker)``. The probe error's message is in the message itself because the consumer stores only `String(error)` on the task (`src/consumer.ts:444`), so a `cause` never reaches the task row. Every other probe rejection is rethrown as it is.
- `DecoderSet` does not log; the Processor logs the `mismatch` (Task 6).
- **Every `inspect` result is checked:** `format` must be in that decoder's `formats`, `contentType` a non-empty string, `width` and `height` finite and above 0, and `pages`, when present, a positive integer. Otherwise: `RESIZE_DECODER_INVALID`, naming the decoder's formats.
- **`createDecoderSet(extra)`:**
  - `undefined` means `[]`. A non-array, or an entry without a non-empty `formats` array of non-empty strings and `inspect` and `render` functions, is `RESIZE_DECODER_INVALID` naming the index.
  - It returns `new DecoderSet([...extra, new SharpDecoder()])`; Task 2 appends `SvgDecoder`.

- [ ] **Step 1: Write the failing tests.** In `src/decoders/sharp.test.ts`:
```ts
test('formats are the raster formats Sharp reads from a buffer, without svg and raw', …)
  // includes 'jpeg', 'png', 'webp', 'gif', 'tiff', 'heif', 'avif'; excludes 'svg', 'raw'
test('inspect reports the format, content type and display size of an EXIF-rotated JPEG', …)
  // 64×48 JPEG with orientation 6 → { format: 'jpeg', contentType: 'image/jpeg', width: 48, height: 64, pages: 1, animated: false }
test('inspect reports one frame of an animation, its page count, and that it animates', …)
  // 3-frame 20×20 GIF → width 20, height 20, pages 3, animated true
test('inspect names an AVIF container avif', …) // sharp(…).avif() bytes → format 'avif', contentType 'image/avif'
test('inspect refuses SVG bytes with RESIZE_SOURCE_FORMAT_UNSUPPORTED, retryable false', …)
test("inspect rethrows Sharp's own error for bytes Sharp cannot read", …)
  // Buffer.from('not an image') → rejects; ResizeError.isResizeError(err) === false
test('inspect applies limits.inputPixels', …) // inputPixels 100 on the 64×48 JPEG → rejects /pixel limit/
test('render decodes upright at the box as 8-bit sRGB', …)
  // 600×400 JPEG, box 180×120 → info { width: 180, height: 120, channels: 3 }, data.length === 180 * 120 * 3
  // the orientation-6 JPEG, box 48×64 → width 48, height 64
test('render never enlarges a raster', …) // box 1000×1000 on 64×48 → 64×48
test('render keeps the frames, delays and loop count it is asked for', …)
  // GIF with delay [100, 200, 300] and loop 3, frames 3 → info.frames 3, height 20, delay [100, 200, 300], loop 3,
  // data.length === 20 * 20 * info.channels * 3; frame 2 is green
test('render with frames 1 gives the first frame only', …) // height 20, (info.frames ?? 1) === 1, red
test('a semi-transparent PNG renders at a resizing box with its colours, not marked premultiplied', …)
  // Review Focus 2: 40×30 RGBA (100, 50, 200, 128), box 20×15 → info.channels 4, info.premultiplied undefined,
  // first pixel within ±2 of [100, 50, 200, 128]
test("render converts a P3-tagged JPEG to sRGB as one Sharp pipeline does", …)
  // 40×40 solid (200, 40, 40) with withIccProfile('p3'), box 20×20 → centre pixel within ±2 of
  // sharp(src).rotate().resize(20, 20).toColorspace('srgb') (measured (200, 38, 41) both ways)
```
In `src/decoderSet.test.ts` (fake decoders are plain objects written out, each counting its `inspect` calls):
```ts
test('identify asks the decoders in order and uses the first that accepts', …)
  // [refuses, accepts, accepts] → result.decoder is the second, result.info is its info, no mismatch;
  // inspect calls: first 1, second 1, third 0
test('a RESIZE_SOURCE_FORMAT_UNSUPPORTED refusal moves on; any other rejection is final', …)
  // [refuses, throws Error('boom'), accepts] → rejects 'boom'; the third is never asked
test('when every decoder refuses, identify rejects with RESIZE_SOURCE_FORMAT_UNSUPPORTED naming the formats tried', …)
  // retryable false; message includes both decoders' formats; cause is the first refusal
test('a stored format picks its decoder first, without asking the others', …)
  // the other decoder's inspect is never called; no mismatch
test('a stored format no decoder lists falls back to the probe and reports the mismatch', …)
  // stored 'jpg' on bytes the second decoder accepts → that decoder, mismatch { stored: 'jpg', reason: 'unlisted' }
test("a refusal from the stored format's decoder falls back to the probe, without asking it again", …)
  // [lists 'png' and refuses, lists 'svg' and accepts], stored 'png' → the second, mismatch { stored: 'png', reason: 'refused' };
  // the first decoder's inspect ran once
test("any other rejection from the stored format's decoder is final", …) // it throws Error('boom') → rejects 'boom'; no other decoder asked
test('when the probe finds nothing: RESIZE_DECODER_MISSING for an unlisted format, else the probe error', …)
  // stored 'pdf', all refuse → ResizeSetupError RESIZE_DECODER_MISSING, retryable true, message names 'pdf', cause the probe error;
  // stored 'pdf', a decoder throws Error('unreadable') → RESIZE_DECODER_MISSING with that cause, and its message includes 'unreadable';
  // stored 'pdf', a decoder throws ResizeMediaError { code: 'TEST_OWN' } → rejects with TEST_OWN;
  // stored 'png' (listed, refused) and all others refuse → RESIZE_SOURCE_FORMAT_UNSUPPORTED, retryable false
test('an empty stored format is probed with no mismatch', …) // '' behaves as no stored format
test('an inspect result outside the contract is RESIZE_DECODER_INVALID', …)
  // format 'png' from a decoder that lists ['pdf']; width 0; contentType ''; pages 1.5
test('createDecoderSet puts the given decoders before the built-in one', …)
  // createDecoderSet([fake]).decoders.length === 2; [0] is fake; [1].formats includes 'jpeg'
test('createDecoderSet refuses entries that are not decoders with RESIZE_DECODER_INVALID', …)
  // 'x'; [{}]; [class {}] (a class, not an instance); [{ formats: [], inspect, render }]; [{ formats: ['pdf'], inspect: 1, render }]
test("verify() runs each decoder's verify(), in order", …) // a rejecting verify rejects verify() with that error
```
In `src/importGraph.test.ts`:
```ts
test('decoders import only contracts, errors, helpers, types and other decoders', …)
  // same shape as the drivers guard; sanity check: the listing includes 'decoders/sharp.ts'
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/decoders/sharp.test.ts src/decoderSet.test.ts src/importGraph.test.ts`. Expected: FAIL with `ERR_MODULE_NOT_FOUND` for the new modules.
- [ ] **Step 3: Implement** `ResizeLimits`, the contract (the header follows `src/contracts/media.ts`: "Extend this class (or pass any object of the same shape — the core never checks instanceof)"), `SharpDecoder` and `DecoderSet` as decided. Export `SourceDecoder` and the types of D12 from `src/index.ts`, and add `'SourceDecoder'` to the lists in `src/index.test.ts` (including the constructor list) and `smokeTest.ts`.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src smokeTest.ts && git commit -m "feat: SourceDecoder port, a Sharp decoder and the decoder set"`

### Task 2: `SvgDecoder`

**Files:**
- Create: `src/decoders/svg.ts`.
- Modify: `src/decoderSet.ts` (the built-in list), `src/decoderSet.test.ts`.
- Test: `src/decoders/svg.test.ts`.

**Interfaces:**
Consumes: `SourceDecoder`, `SourceInfo`, `Raster` (Task 1); `svgNaturalSize`, `svgRasterDensity` (`src/helpers/svgDimensions.ts`), `rasterizeSvg` (`src/helpers/svgRaster.ts`), all unchanged.
Produces:
```ts
// src/decoders/svg.ts
export class SvgDecoder extends SourceDecoder { readonly formats: readonly ['svg'] }
// createDecoderSet(extra) → new DecoderSet([...extra, new SharpDecoder(), new SvgDecoder()])
```
**Decision (the SVG rules move here with their codes):**
- **`inspect`**
  - Runs `sharp(bytes, { limitInputPixels }).timeout(…).metadata()`. A Sharp error is rethrown unchanged. A format other than `svg` is `RESIZE_SOURCE_FORMAT_UNSUPPORTED` (`retryable: false`). No width or height is `RESIZE_SOURCE_METADATA_MISSING` (`retryable: false`).
  - Then, before any density probe (D14): `meta.width × meta.height > limits.sourcePixels` → `ResizeMediaError` `RESIZE_SOURCE_TOO_LARGE`, `retryable: false`, message `` `resize: SVG ${w}x${h} exceeds limits.sourcePixels (${n})` ``.
  - Then `natural = await svgNaturalSize(bytes, meta.width, meta.height, inputPixels, timeoutSeconds)`.
  - Then `svgRasterDensity(bytes, natural.width, natural.height, { pixelBudget: min(sourcePixels, inputPixels), inputPixels, timeoutSeconds })`. `undefined` → `ResizeMediaError` `RESIZE_SVG_DIMENSIONS_UNSUPPORTED`, `retryable: false`, message `resize: SVG dimensions cannot be rasterized within the renderer limits`.
  - Errors from the two helpers are rethrown unchanged.
  - Returns `{ format: 'svg', contentType: 'image/svg+xml', width: natural.width, height: natural.height, vector: true }`.
- **`render`**
  - `largestScale = max(1, box.width / source.width, box.height / source.height)`.
  - The density is computed with that scale; `undefined` is the same `RESIZE_SVG_DIMENSIONS_UNSUPPORTED`.
  - `png = await rasterizeSvg(bytes, { density, limitInputPixels, timeoutMs: processingTimeoutSeconds * 1000, signal })`, with no `mediaId`.
  - Then `sharp(png, { limitInputPixels }).toColorspace('srgb').raw({ depth: 'uchar' })` gives the raster. A PNG decode in-process is safe; the markup was rendered in the child.
- **The order `[…, SharpDecoder, SvgDecoder]`** parses a raster upload once. An SVG upload is parsed by both decoders' `metadata()`; that is one parse more than today, beside the two the SVG checks already do.

- [ ] **Step 1: Write the failing tests.** In `src/decoders/svg.test.ts`:
```ts
test('inspect reports the natural size, the SVG content type and that the source is vector', …)
  // width="120px" height="80px" with a viewBox → { format: 'svg', contentType: 'image/svg+xml', width: 120, height: 80, vector: true }
test('inspect keeps a fractional side', …) // width="1000" height="0.6" → width 1000, Math.abs(height - 0.6) < 0.01
test('inspect refuses raster bytes with RESIZE_SOURCE_FORMAT_UNSUPPORTED, retryable false', …) // a PNG
test('an SVG without a raster pixel on a side is RESIZE_SVG_DIMENSIONS_UNSUPPORTED, retryable false', …)
  // rejected: [1, 100000], [100000, 1], [0.6, 40000], [1, 65535]; accepted: [1, 40000], [40000, 1], [0.7, 40000], [1, 65534]
test('inspect checks limits.sourcePixels before the dimension probe', …)
  // D14: sourcePixels 1000, a 1×100000 SVG (over both limits) → RESIZE_SOURCE_TOO_LARGE, retryable false
test('render runs one child process and returns RGBA at the box', …)
  // mock.method(childProcess, 'spawn') called once; a 20×10 SVG, box 2000×1000 → info { width: 2000, height: 1000, channels: 4 }
test('render never goes below the natural size', …) // box 10×5 on the 20×10 SVG → 20×10
test('a render over limits.processingTimeoutSeconds is RESIZE_SVG_RENDER_TIMEOUT, retryable false, without a media id', …)
  // { timeout: 8000 }; a copy of `heavySvg` from src/processor.test.ts (a private constant there, so copy it);
  // processingTimeoutSeconds 1; err.mediaId === undefined
```
In `src/decoderSet.test.ts`, update 'createDecoderSet puts the given decoders before the built-in ones' (length 3; `[2].formats` deepEqual `['svg']`), and add:
```ts
test('SVG bytes are identified by the SVG decoder after the Sharp decoder refuses them', …)
  // createDecoderSet().identify(svg, limits) → info.format 'svg', decoder.formats deepEqual ['svg']
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/decoders/svg.test.ts src/decoderSet.test.ts`. Expected: FAIL (module not found; the built-in list has two entries).
- [ ] **Step 3: Implement `SvgDecoder`** as decided, and append it in `createDecoderSet`.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src && git commit -m "feat: SvgDecoder renders SVG in its child process behind the decoder port"`

### Task 3: The pure plan: `planVariants`, `decodeBox`, `framesToDecode`

**Files:**
- Create: `src/plan.ts`.
- Modify: `src/importGraph.test.ts`.
- Test: `src/plan.test.ts`.

**Interfaces:**
Consumes: `SourceInfo`, `DecodeBox` (Task 1); `calculateResizedDimensions`, `coverDimensions`, `getPreviewIdentity` (`src/images.ts`); `isAnimatedFormat` (`src/helpers/imageFormat.ts`); `Pipeline` (`src/contracts/pipeline.ts`, type only).
Produces:
```ts
export interface PlanRules {
  scope: PreviewScope;
  maxSize: { width: number; height: number };
  resultDimension: number;
  sharpen: { cover: boolean; fit: boolean } | false;
  ownSize: boolean; // false when the pipeline has variantSteps
  animate: boolean; // config.animated, and the pipeline has neither beforeSteps nor variantSteps
}
export interface SizePlan {
  key: string;      // the geometry, e.g. '620x413:fill:s:' — variants with one key share one render
  width: number; height: number; // exact output size of one frame, integers ≥ 1
  mode: 'fill' | 'cover';        // fill: the aspect ratio is kept (or the size is exact); cover: centre crop
  sharpen: boolean;
  animated: boolean;
}
export interface VariantPlan { variant: MissingPreview; identity: string; size: SizePlan }
export function planRules(config: ResizeConfig, scope: PreviewScope, pipeline: Pipeline): PlanRules;
export function planVariants(info: SourceInfo, requests: readonly MissingPreview[], rules: PlanRules): VariantPlan[]; // request order
export function decodeBox(info: SourceInfo, plans: readonly VariantPlan[], opts: { atLeastOwnSize: boolean }): DecodeBox;
export function framesToDecode(info: SourceInfo, plans: readonly VariantPlan[], limits: ResizeLimits): number;
```
**Decision (the geometry, today's rules made explicit).** `w × h` is `info.width × info.height`. Let `s` be `rules.sharpen`.
- **Fit.** `calculateResizedDimensions(w, h, undefined, undefined, true, maxSize)`, `fill`, sharpened when `s && s.fit`.
- **Own size.** It applies when `rules.ownSize && !info.vector && !fit`, both sides are requested, `w <= round(rw)` and `h <= round(rh)`.
  - `box = coverDimensions(w, h, rw, rh, resultDimension)`, then fit inside it without enlarging: `scale = min(box.width / w, box.height / h, 1)`, each side `max(1, round(side × scale))`, `fill`.
  - It is sharpened only when `scale < 1` and `s && s.cover`.
- **Cover.** `d = coverDimensions(w, h, rw, rh, resultDimension)`.
  - Both sides set: `cover`.
  - One side unset: the other side is `max(1, round(set × aspect))` from `w / h`, `fill`.
  - Sharpened when `s && s.cover`.
- **Animation.** A size is `animated` when `rules.animate && info.animated` and one of its variants has an animated format.
- **Identity.** `getPreviewIdentity(rules.scope, v.sizeKey, v.format, v.filters)`.
- **`decodeBox`**
  - `S` is the largest `max(plan.width / w, plan.height / h)` over the plans. With `atLeastOwnSize`, `S = max(S, 1)`; for a raster source (`!info.vector`), `S = min(S, 1)`.
  - Each side is `max(1, ceil(side × S − 1e-6))`, so 6000 × 0.3 is 1800, not 1801.
- **`framesToDecode`** is 1 unless a plan is `animated`. Otherwise it is `max(1, min(info.pages ?? 1, animationFrames, floor(min(sourcePixels, inputPixels) / (w × h))))`.

- [ ] **Step 1: Write the failing tests.** In `src/plan.test.ts`, with default rules from `planRules(makeImageConfig(), { resizer: 'default', pipeline: 'default' }, {})` unless a test says otherwise:
```ts
test('fit is bounded by maxSize and never enlarges', …)
  // 6000×4000 → 1800×1200 fill, sharpen false; 200×300 → 200×300
test('cover sizes are capped at limits.resultDimension', …) // 9000×9000 on 10000×10000 → 5000×5000 cover
test('a width-only size takes its height from the source aspect ratio', …) // 620w on 6000×4000 → 620×413 fill, sharpen true
test('a derived side over the cap is cropped to the cap', …)
  // resultDimension 200: 100w on 1×100 → 100×200 cover; 100h on 100×1 → 200×100 cover
test('a vector source derives sides from its exact aspect ratio', …)
  // vector 1000×0.6: 5h → 5000×5 cover; 25h on vector 40000×300 → 3333×25 fill
test('own size: a raster no larger than the box keeps its size, unscaled and unsharpened', …) // 100×80 at 300×300 → 100×80 fill, sharpen false
test('own size is decided against the requested box, then fitted inside the cap', …)
  // resultDimension 100: 120×60 at 200×200 → 100×50 fill, sharpen true
test('own size is off with variantSteps and for vector sources', …)
  // planRules(…, { variantSteps: [step] }) → 100×80 at 300×300 is 300×300 cover; vector 100×80 → 300×300 cover
test('own size and fit share one size plan when they have the same geometry', …)
  // 100×80 with 300x300, 200x200 and fit → new Set(plans.map((p) => p.size.key)).size === 1
test('a source larger than the box in one direction is cover-cropped', …) // 1000×200 at 300×300 → 300×300 cover
test('fractional requested sides are rounded', …) // 300.5×200 → 301×200
test('each plan carries the preview identity of its scope', …)
  // scope { resizer: 'listings', pipeline: 'wm' }, filters { blur: 4 } → identity === getPreviewIdentity(scope, '20x20', 'webp', { blur: 4 })
test('a size animates only for an animated source, with animate on, and only for animated formats', …)
  // info { pages: 3, animated: true }, config.animated true: 10w webp and 10w jpeg share one key with animated true;
  // a 20w jpeg alone → animated false; info.animated false → none animated; planRules with beforeSteps → animate false
test('the decode box is the largest scale any plan needs', …)
  // 6000×4000 with fit, 620w and 300×300 → { width: 1800, height: 1200 }
test('a raster box never exceeds the source; a vector box may', …)
  // raster 100×80 at 300×300 cover → 100×80; vector 20×10 with 2000w → 2000×1000
test("with beforeSteps the box is at least the source's own size", …)
  // 6000×4000 with 300×300 and atLeastOwnSize → 6000×4000
test('the box follows the capped sizes, not the requested ones', …)
  // Review Focus 5: vector 100×100, 9000×9000 at the default cap → 5000×5000
test('frames are 1 unless a plan animates, then bounded by pages, animationFrames and the pixel budget', …)
  // pages 100, animationFrames 64, sourcePixels 10 × w × h → 10; pages 3 → 3; no animated plan → 1
```
In `src/importGraph.test.ts`:
```ts
test('plan.ts reaches no sharp at runtime and imports no contract but the decoder and pipeline types', …)
  // walk('plan.ts').bare has no 'sharp'; the contracts in localImports('plan.ts', { types: true }) are a subset of
  // ['contracts/decoder.ts', 'contracts/pipeline.ts']; sanity check: that list includes 'contracts/decoder.ts'
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/plan.test.ts src/importGraph.test.ts`. Expected: FAIL: `plan.test.ts` with `ERR_MODULE_NOT_FOUND`, and the new guard because `plan.ts` does not exist yet.
- [ ] **Step 3: Implement `src/plan.ts`** as decided. It imports no `sharp` and no port.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/plan.ts src/plan.test.ts src/importGraph.test.ts && git commit -m "feat: planVariants, the decode box and the frame count as pure functions"`

### Task 4: The raster helpers and the Sharp steps: `raster.ts`, `renderSize`, `encodeVariant`, `SizedRasters`

**Files:**
- Create: `src/raster.ts` (the boundary between a `Raster` and Sharp), `src/render.ts`.
- Modify: `src/importGraph.test.ts`.
- Test: `src/raster.test.ts`, `src/render.test.ts`.

**Interfaces:**
Consumes: `Raster`, `RasterInfo`, `DecodeBox`, `ResizeLimits` (Task 1); `SizePlan`, `VariantPlan` (Task 3); `VariantStep` (`src/contracts/pipeline.ts`); `isAnimatedFormat`, `isAvifBuffer` (`src/helpers/imageFormat.ts`).
Produces:
```ts
// src/raster.ts
export function rasterProblem(value: unknown): string | undefined;
  // why value is not a Raster, or undefined: data not a Buffer; width, height, channels or frames not positive integers;
  // channels outside 1–4; data.length !== width × height × channels × frames
export function checkRaster(raster: Raster): void; // a decoder's raster: rasterProblem → ResizeSetupError RESIZE_DECODER_INVALID
export function rasterInput(raster: Raster, limits: ResizeLimits): SharpOptions;
  // { raw: { width, height: height × frames, channels, pageHeight (frames > 1), premultiplied (only when true) }, limitInputPixels }
export function rasterToSharp(raster: Raster): Sharp;        // exported from the main entry in Task 6 (D2)
export function sharpToRaster(img: Sharp): Promise<Raster>;  // exported from the main entry in Task 6 (D2)

// src/render.ts
export function straightAlpha(raster: Raster, limits: ResizeLimits): Promise<Raster>;
  // the raster itself unless info.premultiplied; otherwise one Sharp pass to straight alpha, same size, frames and timing, unmarked
export function firstFrame(raster: Raster): Raster; // the top frame, without timing
export function reduceToBox(raster: Raster, box: DecodeBox, limits: ResizeLimits): Promise<Raster>;
  // one frame; the raster itself unless both sides exceed the box; otherwise resize(box, { fit: 'outside' }) → sRGB → raw
export function renderSize(raster: Raster, size: SizePlan, limits: ResizeLimits): Promise<Raster>;
export class SizedRasters {
  constructor(raster: Raster, plans: readonly VariantPlan[], limits: ResizeLimits);
  get(size: SizePlan): Promise<Raster>; // one renderSize per size key, shared
  release(size: SizePlan): void;        // after the last variant of that key, the sized raster is dropped
}
export interface EncodeOptions { variantSteps: readonly VariantStep[]; ctx: Record<string, unknown>; encode: ResizeConfig['encode']; limits: ResizeLimits }
export interface EncodedVariant { data: Buffer; format: string; contentType: string; width: number; height: number } // width/height: one frame
export function encodeVariant(sized: Raster, plan: VariantPlan, opts: EncodeOptions): Promise<EncodedVariant>;
```
**Decision:**
- **`src/raster.ts` holds every conversion between a `Raster` and Sharp**, so a later engine port can be cut there (see Follow-ups). `rasterToSharp` and `sharpToRaster` are as D2 states; `sharpToRaster` rejects a result with `info.pages > 1` (measured: Sharp reports `pages: 3` and stacks the frames) with `ResizeSetupError` `RESIZE_PIPELINE_STEP_INVALID`, "a beforeStep must return one frame". `rasterProblem` imports no Sharp; it is the one shape check for decoder rasters (`checkRaster`) and step results (Task 6).
- **Every function in `render.ts` takes a straight-alpha raster** except `straightAlpha` itself, which the Processor calls once, right after `checkRaster` (D1), and `runBeforeSteps` calls on a step's returned raster marked premultiplied (Task 6). That is why the `renderSize` shortcut needs no premultiplied check.
- **`renderSize`**
  - It returns the raster itself when it already has the size's width and height, `size.sharpen` is false and it has 3 or 4 channels.
  - Otherwise it runs `resize(width, height, { fit: mode === 'cover' ? 'cover' : 'fill', position: 'center' })` → `toColorspace('srgb')` → `sharpen()` when asked → `raw({ depth: 'uchar' })` → `.timeout(…)`.
  - For an animated size it does this frame by frame and stacks the results, keeping `delay` and `loop`. For a size that does not animate it starts from `firstFrame(raster)`.
- **`encodeVariant`**
  - It starts from the sized raster, or its first frame when the format is not animated.
  - `variantSteps` in order, then `flatten({ background })` when the raster has 2 or 4 channels and the format is in `encode.flatten.formats`.
  - Then `toFormat(format, { ...(frames > 1 ? { delay, loop } : {}), ...encode.formats[format] })`, `.timeout(…)` and `toBuffer({ resolveWithObject: true })`.
  - The format is `'avif'` when Sharp says `heif` and `isAvifBuffer(data)`. `'svg'` is `ResizeMediaError` `RESIZE_SVG_PUBLIC_PREVIEW`. `contentType` is `` `image/${format}` ``.
  - `width` is `info.width`; `height` is `info.pageHeight ?? info.height`.

- [ ] **Step 1: Write the failing tests.** In `src/raster.test.ts`:
```ts
test('checkRaster rejects a raster that is not a Raster with RESIZE_DECODER_INVALID', …)
  // 10×10×3 info with 299 bytes; channels 5; frames 0; width 1.5; data a Uint8Array
test('rasterToSharp and sharpToRaster round-trip the pixels', …)
  // a 20×10×3 raster → sharpToRaster(rasterToSharp(r)) has the same info and bytes; a 1-channel raster → channels 3
test('sharpToRaster never forwards the premultiplied flag', …)
  // Review Focus 2: 40×30 RGBA (100, 50, 200, 128) → sharpToRaster(rasterToSharp(r).resize(20, 15)) → first pixel within ±2,
  // info.premultiplied undefined
test('sharpToRaster rejects a multi-page image with RESIZE_PIPELINE_STEP_INVALID', …) // sharp(threeFrameGif, { animated: true })
```
In `src/render.test.ts` (rasters built in the test from solid colours):
```ts
test('renderSize returns the raster itself when nothing changes', …) // a 20×10×3 raster, size 20×10 fill, no sharpen → out === raster
test('renderSize fills exact sizes and cover-crops the centre', …)
  // 40×20, left half red, right half blue; cover 20×20 → pixel (2, 10) red, (17, 10) blue; fill 10×10 → 10×10
test('renderSize turns a grey raster into sRGB', …) // a 1-channel raster → channels 3
test('renderSize resizes every frame of an animation and keeps its timing', …)
  // 3 frames of 20×20 (red, green, blue), delay [100, 200, 300], loop 3; animated 10×10 → frames 3, height 10,
  // frame colours unchanged, delay and loop unchanged
test('encodeVariant writes animated WebP and GIF with the source delays and loop count', …)
  // Review Focus 1: metadata(animated) of each → pages 3, delay [100, 200, 300], loop 3
test('encodeVariant gives a format that cannot animate the first frame', …) // jpeg from the 3-frame raster → height 10, red
test('a semi-transparent raster keeps its colours through renderSize and encode', …)
  // Review Focus 2: 40×30 RGBA (100, 50, 200, 128) → renderSize 20×15 fill → png → first pixel within ±2 of [100, 50, 200, 128]
test('straightAlpha turns a premultiplied raster into straight alpha, and leaves a straight one alone', …)
  // Review Focus 2: 8×4 RGBA (50, 25, 100, 128) marked premultiplied → first pixel within ±2 of [100, 50, 200, 128],
  // info.premultiplied undefined; an unmarked raster → the same object
test('reduceToBox shrinks a larger raster to cover the box and leaves a smaller one alone', …)
  // 600×400 with box 300×200 → 300×200; 600×400 with box 300×250 → 375×250; 200×100 with box 300×200 → the same object
test('encodeVariant flattens alpha onto the background for the listed formats', …) // a transparent raster → jpeg pixel ≈ white
test('encodeVariant runs variantSteps on the sized pixels, in order', …)
  // two steps record [name, (await img.metadata()).width] → [['a', 20], ['b', 20]]
test('encodeVariant reports the encoded size and content type', …)
  // jpeg 20×10 → { format: 'jpeg', contentType: 'image/jpeg', width: 20, height: 10 }; animated webp → height 10
test('SizedRasters renders each size once for the variants that share it, and drops it after the last', …)
  // two plans with one key: get(a) === get(b) (the same promise); release both → the next get is a new promise
```
In `src/importGraph.test.ts`:
```ts
test('plan.ts, raster.ts and render.ts reach no storage, media, task-queue or lock contract', …)
  // for each, walk(f, { types: true }).files has none of contracts/storage.ts, contracts/media.ts, contracts/taskQueue.ts,
  // contracts/locks.ts; sanity check: walk('render.ts', { types: true }) reaches 'contracts/pipeline.ts'
test('only the allowed shipped files import sharp', …)
  // the shipped files (sourceFiles()) whose importSpecifiers(readFileSync(file, 'utf8'), { types: true }) include 'sharp',
  // sorted, deepEqual:
  // contracts/pipeline.ts (the Sharp type of variantSteps), decoders/sharp.ts, decoders/svg.ts, helpers/svgDimensions.ts,
  // helpers/svgRasterChild.ts, processor.ts (until Task 6), raster.ts, render.ts, uploader.ts (until Task 7),
  // worker.ts (sharp.concurrency and sharp.cache)
```
The allowlist starts with today's importers (checked with `grep -rln "'sharp'" src`, tests and test helpers excluded: `contracts/pipeline.ts`, `helpers/svgDimensions.ts`, `helpers/svgRasterChild.ts`, `processor.ts`, `uploader.ts`, `worker.ts`) plus the S3 files (`decoders/sharp.ts`, `decoders/svg.ts`, `raster.ts`, `render.ts`). Task 6 removes `processor.ts` and Task 7 removes `uploader.ts`, so every commit stays green and the final list is the one the Architecture section names. `plan.ts`, the Uploader, the Processor and the other services are not on it.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/raster.test.ts src/render.test.ts src/importGraph.test.ts`. Expected: FAIL: `raster.test.ts` and `render.test.ts` with `ERR_MODULE_NOT_FOUND`, and the new guards because `raster.ts` and `render.ts` do not exist yet.
- [ ] **Step 3: Implement `src/raster.ts` and `src/render.ts`** as decided. They import no port and nothing from `resizer.ts`.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/raster.ts src/raster.test.ts src/render.ts src/render.test.ts src/importGraph.test.ts && git commit -m "feat: raster helpers; render each size once and encode each format from it"`

### Task 5: `PreviewRecorder`: the persist step, moved unchanged

**Files:**
- Create: `src/previewRecorder.ts`.
- Modify: `src/processor.ts:108-119` (`describeRefs`) and `:779-859` (the persist block in `#generatePreviews`).
- Test: `src/previewRecorder.test.ts`. The `persist failure` and `one preview row per identity` tests in `src/processor.test.ts` must pass unchanged.

**Interfaces:**
Produces:
```ts
export interface PreviewRecorderDeps { catalog: Catalog; media: MediaStore; logger: ResizeLogger }
export interface RecordResult { stored: Preview[]; alreadyStored: string[] }
  // stored: the generated Preview objects whose identity the media store kept (not the objects the store resolved with,
  // which may be driver documents), as today at src/processor.ts:826-829 and :856-858
export class PreviewRecorder {
  constructor(deps: PreviewRecorderDeps);
  record(mediaId: string, scope: PreviewScope, generated: Preview[], backfillDims?: { width: number; height: number }): Promise<RecordResult>;
}
```
**Decision:** a pure move. The body, the log lines, the rethrow and `RESIZE_MEDIA_APPEND_RESULT_INVALID` are today's. The Processor keeps the `onPreviewGenerated` loop, over `stored`. The Processor builds one recorder in its constructor.

- [ ] **Step 1: Write the failing tests.** In `src/previewRecorder.test.ts`:
```ts
test('a PreviewRecorder needs only a catalog, a media store and a logger, and returns the previews the store kept', …)
  // fakeMedia keeps one row per identity; two previews, one already stored → stored has 1, alreadyStored names the other;
  // stored[0] is the generated object itself (===), not the store's copy
test('a store that resolves undefined is RESIZE_MEDIA_APPEND_RESULT_INVALID', …)
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/previewRecorder.test.ts`. Expected: FAIL with `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Move the code** and call `this.#recorder.record(…)` where the block was.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS, with `src/processor.test.ts` unchanged.
- [ ] **Step 5: Commit.** `git add src && git commit -m "refactor: move the persist reconciliation into PreviewRecorder"`

### Task 6: The Processor on the new steps; `beforeSteps` receive and return a `Raster`

**Files:**
- Rewrite: `src/processor.ts`. `#generatePreviews`, `withoutVisibleLoss` and the Sharp and SVG-helper imports go.
- Modify:
  - `src/contracts/pipeline.ts` (`BeforeStep`; the `Metadata` type import goes, the `Sharp` type stays for `VariantStep`);
  - `src/render.ts` (add `runBeforeSteps`);
  - `src/index.ts`, `src/index.test.ts` (`EXPECTED_VALUE_EXPORTS`), the `expected` list of `CHECK_CORE` in `smokeTest.ts` (export `rasterToSharp` and `sharpToRaster`);
  - `src/resizer.ts:363-391` (`#ensureServices` passes `decoders`) and the constructor at `:191` (builds `createDecoderSet()` once);
  - `src/architecture.test.ts`, `src/importGraph.test.ts` (`processor.ts` leaves the sharp allowlist).
- Test: `src/processor.test.ts`, `src/render.test.ts`.

**Interfaces:**
Consumes: Tasks 1–5.
Produces:
```ts
// src/contracts/pipeline.ts
export type BeforeStep = (raster: Raster, meta: { media: MediaLike; source: SourceInfo; scale: number; ctx: Record<string, unknown> }) => Raster | Promise<Raster>;
// src/index.ts: export { rasterToSharp, sharpToRaster } from './raster.ts' (the module is Task 4's; exported here, with the step change)
// src/render.ts
export function runBeforeSteps(raster: Raster, steps: readonly BeforeStep[],
  meta: { media: MediaLike; source: SourceInfo; ctx: Record<string, unknown> }, limits: ResizeLimits): Promise<Raster>;
  // adds meta.scale per step: the width of the raster that step receives / source.width
// src/processor.ts
export interface ProcessorDeps { catalog; media; storage; decoders: DecoderSet; pipelines; hooks; config; logger; name } // + decoders
```
**Decision (`#renderPending`, which replaces `#generatePreviews`).** `generate()`, `processTask()` and `notify()` keep their behaviour and call it. Each step is a module-private function with narrow parameters, or one of the earlier tasks' pieces:
1. `requirePipeline`. Keep the variants not stored yet; nothing pending → return.
2. Split off the variants whose format has no `encode.formats` entry with `catalog.splitConfigured` (`src/catalog.ts:90-95`). Each one is logged and counted as failed with `RESIZE_FORMAT_NOT_CONFIGURED`, before any download. If none is left → return.
3. `loadSource({ storage, decoders, limits, logger }, original, mediaId)`:
   - download once;
   - `decoders.identify(bytes, limits, original.format)`;
   - when the result has a `mismatch`, one `logger.warn` for this task: `` `resize worker: media ${mediaId} is stored as '${stored}' but its bytes are '${info.format}' (${reason === 'unlisted' ? 'no decoder lists the stored format' : 'its decoder refused the bytes'}); rendering it as '${info.format}'` ``;
   - if `info.width × info.height > limits.sourcePixels` → `RESIZE_SOURCE_TOO_LARGE`, `retryable: false`, with the message `` `resize: source ${w}×${h} exceeds limits.sourcePixels (${n}) for media ${mediaId}` ``.
4. `planVariants(info, pending, planRules(config, scope, pipeline))`, then `framesToDecode` and `decodeBox(…, { atLeastOwnSize: beforeSteps.length > 0 })`.
5. `decoder.render(bytes, box, { limits, signal, source: info, frames })`, then `checkRaster`, then `straightAlpha` (D1). The rejections of `identify`, `render` and `straightAlpha` go through `sourceError(err: unknown, mediaId: string): unknown` (D4):
   - a branded error whose `mediaId` property exists and is `undefined` becomes a `ResizeMediaError` with the message `<its message> (media <mediaId>)` and `{ mediaId, code: err.code, retryable: err.retryable, cause: err }`;
   - any other branded error is returned unchanged;
   - anything else becomes a `ResizeMediaError` with the message `` `resize: decoding the source failed for media ${mediaId}: ${message}` `` and `{ mediaId, code: 'RESIZE_SOURCE_DECODE_FAILED', cause: err }` (retryable by default).
6. With `beforeSteps`:
   - `raster = await runBeforeSteps(raster, …)`; the Processor holds no other reference to the pre-step raster (D2, memory).
   - When the result exceeds `min(sourcePixels, inputPixels)` → `RESIZE_SOURCE_TOO_LARGE` (`retryable: false`), "processed source exceeds pixel limits". This is checked on the returned raster's dimensions.
   - When the result's size differs from the rendered raster, re-plan with `{ ...info, width, height, pages: 1, animated: false, vector: false }`.
   - Then `raster = await reduceToBox(raster, decodeBox(info′, plans, { atLeastOwnSize: false }), limits)`, where `info′` is the re-planned info (or `info`): the sizes are rendered from the box, not from the full-size raster.
7. `runBounded(plans, config.concurrency, signal, …)`, in request order. Each variant does `sized.get`, then `encodeVariant`, then the upload (key `previews/${randomHex()}.${format}`, `parentRef`). A nullish storage ref from the upload is `ResizeStorageError` `RESIZE_PREVIEW_STORAGE_REF_INVALID` for that variant, as today (`src/processor.ts:730-737`). Then it builds its `Preview` row. A failure is logged and counted per variant, and `sized.release` runs in `finally`.
8. With `persist`: `PreviewRecorder.record`, where `backfillDims` is the rounded `info` size when the original has none. Then `onPreviewGenerated` for each stored row.

**`runBeforeSteps`** (it calls no Sharp itself, except through `straightAlpha`)
- It hands each step `current` and `{ ...meta, scale: current.info.width / meta.source.width }`, where `current` starts as the decoded first frame.
- The step's resolved value is checked with `rasterProblem` (Task 4), plus `frames` absent or 1. Any problem is `ResizeSetupError` `RESIZE_PIPELINE_STEP_INVALID`, with a message that names the problem and says a `beforeStep` receives and returns a `Raster` (`rasterToSharp` / `sharpToRaster` wrap a Sharp step).
- A returned raster marked `premultiplied: true` goes through `straightAlpha` (D1). A rejection there, like a step's own rejection, passes through unchanged (`sourceError` wraps only the decode).
- The result replaces `current`, so the core holds at most the step's input while the step runs and drops it when the step resolves.

- [ ] **Step 1: Write the failing tests.** In `src/processor.test.ts`:
  - A local `RecordingDecoder extends SourceDecoder` wraps a `SharpDecoder` or `SvgDecoder`, lists its formats, records each `render` box, and can be told to reject or to return a given raster.
  - `processorDeps()` (`src/processor.test.ts:392-404`) hard-codes a jpeg-only config: it takes config overrides (`makeImageConfig({ formats: ['jpeg'], ...overrides })`), a `decoders` set (default `createDecoderSet()`) and a logger, so the tests below can set `maxSize`, formats, `animated` and a recording logger.
```ts
test('the source is decoded once per task, at the largest box the previews need', …)
  // 600×400 PNG, original.format 'png', maxSize 300×200; fit, 100×100 and 50w × jpeg and webp →
  // one render with box { width: 300, height: 200 }, 6 uploads
test('a decoder whose render rejects fails the task before any upload, with its code, retryable and media id', …)
  // Review Focus 4: render rejects ResizeMediaError { code: 'TEST_RENDER', retryable: false } →
  // processTask rejects with code 'TEST_RENDER', retryable false, mediaId 'm1'; uploads 0, appendCalls 0;
  // eager generate() rejects with the same code (not ResizeGenerateError)
test('a source Sharp cannot decode fails with RESIZE_SOURCE_DECODE_FAILED, retryable, with the media id and the cause', …)
  // original.format 'jpeg', storage returns Buffer.from('not an image') → processTask and generate() reject with a
  // ResizeMediaError, code RESIZE_SOURCE_DECODE_FAILED, retryable true, mediaId 'm1', cause set; uploads 0
test('a stored png original holding SVG markup is rendered by the SVG decoder in its child process', …)
  // Review Focus 3: decoders createDecoderSet([recordingSharp, recordingSvg]); original { format: 'png' },
  // storage returns smallSvg → resolves; recordingSharp.renders.length === 0, recordingSvg.renders.length === 1,
  // countRenders() === 1; the previews are uploaded; exactly one logs.warn entry, naming 'png' and 'svg'
test('an original stored under an alias renders, with one warning', …)
  // original.format 'jpg' on a JPEG → previews uploaded; one warning, "no decoder lists the stored format"
test('a decoder raster marked premultiplied is encoded with straight colours', …)
  // Review Focus 2: a RecordingDecoder returns an 8×4 RGBA raster (50, 25, 100, 128) with premultiplied true;
  // a png preview → first pixel within ±2 of [100, 50, 200, 128]
test('the SVG raster follows the capped size, not the requested one', …)
  // Review Focus 5: limits.resultDimension 500; a 100×100 SVG at 900×900 → one render with box { width: 500, height: 500 };
  // preview 500×500
test('an animated GIF keeps its frame delays and loop count in WebP and GIF previews', …)
  // Review Focus 1: animated true; 3-frame GIF, delay [100, 200, 300], loop 3 → each webp and gif upload:
  // pages 3, delay [100, 200, 300], loop 3
test('with beforeSteps an animation renders from its first frame', …) // animated true, beforeSteps [(r) => r] → webp pages 1
test('a beforeStep that returns a different size re-plans every variant from it', …)
  // 64×48 PNG; beforeSteps [async (r) => sharpToRaster(rasterToSharp(r).resize(32, 24))]; fit and 300×300 →
  // fit 32×24, 300×300 own size 32×24
test('a beforeStep that resolves with anything but a one-frame Raster is RESIZE_PIPELINE_STEP_INVALID', …)
  // each case → ResizeSetupError with that code, retryable true; uploads 0:
  // a Buffer: async (r) => rasterToSharp(r).png().toBuffer(); a Sharp instance: (r) => rasterToSharp(r);
  // a two-frame raster: { data: Buffer.alloc(w * h * 3 * 2), info: { width: w, height: h, channels: 3, frames: 2 } };
  // a wrong data length: { data: r.data.subarray(1), info: r.info }
test('an old Buffer-style beforeStep fails inside its own sharp() call', …)
  // beforeSteps [async (buf) => sharp(buf).blur(5).toBuffer()] → processTask rejects with Sharp's Error /Input file is missing/,
  // ResizeError.isResizeError(err) === false (the CHANGELOG states this failure); uploads 0
```
Rewrite the existing tests for the new `BeforeStep`. Every step takes `(raster, meta)` and returns a `Raster`:
- 'beforeSteps run ONCE and see DISPLAY-orientation pixels' records `raster.info.width`, `raster.info.height` and `meta.scale` → `[{ w: 48, h: 64, scale: 1 }]`, and returns `raster`.
- 'a beforeStep that round-trips sharp().toBuffer() keeps final orientation' becomes 'a beforeStep through the Sharp helpers keeps the final orientation': `async (r) => sharpToRaster(rasterToSharp(r))`, then 48×64.
- 'a beforeSteps result over the pixel limits …' returns `sharpToRaster(sharp(grown))`; the check runs on its dimensions.
- 'real ctx reaches beforeSteps and variantSteps' returns `raster`.
- **The 'EXIF orientation quality' block** (`src/processor.test.ts:2294-2422`). Its `score()` helper compares against Sharp's direct path, which uses JPEG shrink-on-load for some sizes while the new path resizes the full decode, so 'orientation 6 without beforeSteps' would fail as written (measured: 100x120 scores 51.84 dB for orientation 6 against ∞ for orientation 1, so `db >= baseline - 0.5` is false).
  - `score()` builds a full-decode reference instead: `sharp(source).rotate().toColorspace('srgb').raw()` at full size, then from those raw pixels the same resize the plan makes: the preview's output size, `fit: 'cover'` for `100x120` and `'fill'` for `fit` and `100w`, `position: 'center'`, `toColorspace('srgb')`, `sharpen()` for all but `fit`.
  - 'orientation 6 without beforeSteps' keeps its dims assertion; both orientations are scored, and every size of each must reach `>= 50` dB. The `baseline - 0.5` clause is dropped: a comparison between orientations adds nothing once both are scored against the same full-decode reference. Measured with the planned path: ∞ for every size of both orientations (the fit size is the whole source, so the box is the full source here).
  - 'orientation 6 with beforeSteps: normalised first, without visible loss' becomes 'orientation 6 with beforeSteps: the steps see upright pixels and nothing is re-encoded': its step records `raster.info` and returns the raster; it sees `{ width: 200, height: 300 }`, and each score is `>= 50`. Against the old shrink-on-load reference this threshold would pass with only about 1.8 dB to spare (51.84 dB); against the full-decode reference the measured score is ∞, so 50 dB leaves a wide margin and still catches a lossy step (a default JPEG round trip of this texture scores about 35 dB).
- Delete 'an oriented WebP with beforeSteps is normalised with a fast lossy encode': there is no intermediate encode any more.
- 'beforeSteps receive the rendered PNG …' becomes 'beforeSteps receive the rendered SVG pixels: one render, and a large size stays sharp'. Its `seen` is `{ width: raster.info.width, channels: raster.info.channels, sourceFormat: source.format, scale }` → `{ width: 2000, channels: 4, sourceFormat: 'svg', scale: 100 }`; the step returns `raster`; the size and edge assertions are unchanged.

In `src/render.test.ts`:
```ts
test('runBeforeSteps hands each step the current raster with its scale, and passes the result on', …)
  // a 40×20 raster, source { width: 20, height: 10, vector: true }: step 1 sees scale 2 and returns a 10×10 raster
  // (sharpToRaster(rasterToSharp(r).extract(…))); step 2 sees width 10 and scale 0.5 → result info 10×10
test('runBeforeSteps keeps semi-transparent colours through the helpers', …)
  // Review Focus 2: 40×30 RGBA (100, 50, 200, 128), a step sharpToRaster(rasterToSharp(r).resize(20, 15)) →
  // first pixel within ±2 of [100, 50, 200, 128], info.premultiplied undefined
test('a returned raster marked premultiplied is converted to straight alpha', …)
  // Review Focus 2: a step returns 8×4 RGBA (50, 25, 100, 128) with premultiplied true → first pixel within ±2 of
  // [100, 50, 200, 128], info.premultiplied undefined
test('a step result that is not a one-frame Raster is RESIZE_PIPELINE_STEP_INVALID', …)
  // a Buffer; undefined; a Sharp instance; channels 5; width 0; frames 2; data one byte short; data a Uint8Array
```
In `src/architecture.test.ts`:
```ts
test('generatePreviews is gone', …) // no file in sourceFiles() contains 'generatePreviews'
test('the Processor has no SVG branch', …) // processor.ts: no `'svg'` literal
```
In `src/importGraph.test.ts`, remove `processor.ts` from the sharp allowlist of Task 4.

The pdf end-to-end test of Task 8 uses no `beforeSteps`, so it does not change.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/processor.test.ts src/render.test.ts src/architecture.test.ts src/importGraph.test.ts src/index.test.ts`. Expected: FAIL: the new tests, the rewritten `beforeSteps` tests (type and behaviour), the EXIF quality test without `beforeSteps` (its new full-decode reference), the export list, and the guards.
- [ ] **Step 3: Implement** the `BeforeStep` type, `runBeforeSteps` and the Processor as decided, and export `rasterToSharp` and `sharpToRaster` from `src/index.ts` (with `src/index.test.ts` and `smokeTest.ts`). Rewrite the Processor's header comment for the new flow. `Resizer` builds `createDecoderSet()` once in its constructor and passes it as `decoders`.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS. Every SVG, animated, cover-size, own-size and concurrency test in `src/processor.test.ts` passes unchanged through the decoders, and the EXIF tests pass as rewritten above; the SVG exact-size table ('a normal SVG keeps its output sizes …') is the parity check.
- [ ] **Step 5: Commit.** `git add src && git commit -m "refactor!: the Processor decodes once per task and resizes once per size; beforeSteps receive and return a Raster"`

### Task 7: The Uploader on `inspect`

**Files:**
- Modify:
  - `src/uploader.ts:26-131` (`prepareOriginal` and `originalStorageInfo` give way to `identifyOriginal`) and `:133-145` (`UploaderDeps`);
  - `src/resizer.ts` (pass `decoders` to the `Uploader`);
  - `src/architecture.test.ts`, `src/importGraph.test.ts` (`uploader.ts` leaves the sharp allowlist).
- Test: `src/uploader.test.ts`. Every existing test passes unchanged except the deps of the direct `Uploader` test.

**Interfaces:**
Consumes: `DecoderSet`, `createDecoderSet` (Task 1).
Produces:
```ts
export interface UploaderDeps { storage: ResizeStorage; decoders: DecoderSet; config: ResizeConfig }
```
**Decision (the upload order and the error mapping):**
- **The checks run in this order:**
  1. the body checks, as today;
  2. `decoders.identify(body, config.limits)` (for SVG, `SvgDecoder.inspect` checks `sourcePixels` before its density probe, so today's order holds, D14);
  3. `info.width × info.height × (info.pages ?? 1) > sourcePixels` → `RESIZE_ORIGINAL_TOO_MANY_PIXELS` (today's message);
  4. `upload.formats` → `RESIZE_ORIGINAL_FORMAT_DISABLED`;
  5. `format === 'svg' && visibility === 'public'` → `RESIZE_ORIGINAL_SVG_PUBLIC`;
  6. the key `originals/<hex>.<jpeg → jpg, else format>`, with `contentType` from `info`;
  7. `width` and `height` are `max(1, round(…))` of `info`.
- **`identify` rejections map as follows** (all but the setup and config errors become a `ResizeOriginalError`):

  | From `identify` | Becomes |
  |---|---|
  | `RESIZE_SOURCE_FORMAT_UNSUPPORTED` | `RESIZE_ORIGINAL_FORMAT_UNSUPPORTED` |
  | `RESIZE_SOURCE_METADATA_MISSING` | `RESIZE_ORIGINAL_METADATA_MISSING` |
  | `RESIZE_SOURCE_TOO_LARGE` (the SVG check, D14) | `RESIZE_ORIGINAL_TOO_MANY_PIXELS`, with the decoder's message |
  | a `ResizeSetupError` or `ResizeConfigError` (by the brand and `err.name`, never `instanceof`) | passes through unchanged: a wiring bug, such as `RESIZE_DECODER_INVALID` from a broken host decoder, is not an invalid original |
  | any other `ResizeError` | the same message, `code` and `retryable` |
  | any other error | `RESIZE_ORIGINAL_INVALID`, "bytes are not a supported image" |

  Every mapped error keeps the original error as `cause`. The mapped codes keep today's `retryable` (the default).

- [ ] **Step 1: Write the failing tests.** In `src/uploader.test.ts` (fake decoders are plain objects; `new Uploader({ storage, decoders, config })`):
```ts
test('an Uploader stores an original with only storage, decoders and config', …) // the existing test; deps gain decoders: createDecoderSet()
test("the format, content type and extension come from the decoder that reads the bytes", …)
  // a fake 'pdf' decoder reporting 120.4×80.6, upload.formats with 'pdf' → key /\.pdf$/, contentType 'application/pdf', width 120, height 81
test('a format a decoder identifies but upload.formats lacks is RESIZE_ORIGINAL_FORMAT_DISABLED', …) // nothing stored
test("a decoder's own ResizeError reaches the caller as a ResizeOriginalError with its code and retryable", …)
  // ResizeMediaError { code: 'TEST_CODE', retryable: false } → ResizeOriginalError, code 'TEST_CODE', retryable false, cause set
test("a decoder's other error is RESIZE_ORIGINAL_INVALID with the cause", …)
test('a setup error from a decoder reaches the caller unchanged', …)
  // inspect rejects ResizeSetupError { code: 'TEST_SETUP' } → rejects with that error (name 'ResizeSetupError'), not a
  // ResizeOriginalError; an inspect result outside the contract → ResizeSetupError RESIZE_DECODER_INVALID
test('bytes every decoder refuses are RESIZE_ORIGINAL_FORMAT_UNSUPPORTED', …) // new DecoderSet([a decoder that always refuses])
test("a decoder's RESIZE_SOURCE_METADATA_MISSING is RESIZE_ORIGINAL_METADATA_MISSING", …)
test('an SVG over the pixel limit and the side limit reports RESIZE_ORIGINAL_TOO_MANY_PIXELS, as today', …)
  // D14: sourcePixels 1000, a 1×100000 SVG → RESIZE_ORIGINAL_TOO_MANY_PIXELS; nothing stored
```
In `src/importGraph.test.ts`, remove `uploader.ts` from the sharp allowlist (Task 4). The final list: `contracts/pipeline.ts`, `decoders/sharp.ts`, `decoders/svg.ts`, `helpers/svgDimensions.ts`, `helpers/svgRasterChild.ts`, `raster.ts`, `render.ts`, `worker.ts`.

In `src/architecture.test.ts`:
```ts
test('only the SVG decoder imports the SVG helpers', …)
  // helpers/svgDimensions.ts and helpers/svgRaster.ts are imported by decoders/svg.ts alone (among shipped files)
```
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/uploader.test.ts src/architecture.test.ts src/importGraph.test.ts`. Expected: FAIL: the new tests, and the guards (`uploader.ts` imports `sharp` and the SVG helpers).
- [ ] **Step 3: Implement** as decided. The Resizer passes the same `DecoderSet` to the `Uploader` and the `Processor`.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS. Every SVG upload test passes through `SvgDecoder` with today's codes.
- [ ] **Step 5: Commit.** `git add src && git commit -m "refactor: uploadOriginal identifies the original through the decoders"`

### Task 8: The `decoders` option, decoder `verify()`, and a test-only `pdf` decoder end to end

**Files:**
- Modify: `src/resizer.ts:57-82` (`ResizerOptions`), the constructor (`createDecoderSet(opts.decoders)` before the name is registered), and `verify()` at `:501-518` (`await decoders.verify()` after `media` and `locks`).
- Create: `src/testHelpers/pdfDecoder.ts`.
- Modify: `src/architecture.test.ts`.
- Test: `src/customDecoder.test.ts`.

**Interfaces:**
Produces:
```ts
// src/resizer.ts — ResizerOptions
decoders?: SourceDecoder[]; // asked before the built-in Sharp and SVG decoders; FrameworkResizer passes it through
// src/testHelpers/pdfDecoder.ts
export function fakePdf(width: number, height: number, color: [number, number, number]): Buffer; // `%PDF-fake ` + JSON
export class TestPdfDecoder extends SourceDecoder {
  readonly formats = ['pdf'];
  readonly renders: DecodeBox[]; // every box render() was asked for
  // inspect: bytes not starting with `%PDF-fake ` → ResizeMediaError RESIZE_SOURCE_FORMAT_UNSUPPORTED (retryable false);
  //          else { format: 'pdf', contentType: 'application/pdf', width, height, vector: true }
  // render: a solid `color` raster of exactly `box`, 3 channels
}
```
- [ ] **Step 1: Write the failing tests.** In `src/customDecoder.test.ts`, with a `new Resizer({ storage: in-memory, media: fakeMedia(…), config: makeImageConfig({ upload: { formats: [...the defaults, 'pdf'] } }), decoders: [pdf] })`:
```ts
test('a pdf decoder in `decoders` stores a pdf original and renders its previews, eager and queued', …)
  // uploadOriginal(fakePdf(300, 200, [200, 30, 30]), private) → format 'pdf', contentType 'application/pdf', 300×200, key /\.pdf$/
  // generate({ sizes: [{ width: 150, height: 100 }, { fit: true }], formats: ['jpeg', 'webp'] }) → 4 created, 150×100 and 300×200,
  // each body's centre pixel within ±8 of [200, 30, 30]; pdf.renders deepEqual [{ width: 300, height: 200 }]
  // processTask (src/worker.ts) for a 60×60 webp → one more upload, red centre
test('a pdf upload is refused when upload.formats lacks pdf', …) // RESIZE_ORIGINAL_FORMAT_DISABLED, nothing stored
test('a pdf original in a process without the pdf decoder is RESIZE_DECODER_MISSING', …)
  // no decoder lists 'pdf', and the probe ends with Sharp's own error on the fakePdf bytes →
  // generate() and processTask reject with ResizeSetupError, that code, retryable true, a cause
test('a decoder for a built-in format is chosen before the built-in one', …)
  // a decoder listing ['png'] that delegates to the built-in path and counts renders → a stored png renders through it
test('decoders that are not decoders are RESIZE_DECODER_INVALID at construction, and the name stays free', …)
test("verify() runs each decoder's verify()", …) // a decoder whose verify rejects → resizer.verify() rejects with that error
```
In `src/architecture.test.ts`:
```ts
test('no shipped file names the pdf format', …) // no file in sourceFiles() matches /['"`]pdf['"`]/
```
Comments may mention "a PDF decoder" in words, but never as a quoted format id, including in the port's doc comment.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `node --experimental-strip-types --test src/customDecoder.test.ts`. Expected: FAIL. The type check reports `decoders` as an unknown option, and the run finds no decoder for `pdf`.
- [ ] **Step 3: Implement** the option, the `verify()` call and the test helper. No other core file changes.
- [ ] **Step 4: Run everything to verify it passes.** Run: `npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src && git commit -m "feat: new Resizer({ decoders }) adds source kinds; a test-only pdf decoder proves it"`

### Task 9: The benchmark `bench/renderOnce.ts`

**Files:**
- Create: `bench/renderOnce.ts`.

**Interfaces:**
Consumes: `Resizer` and `ResizeStorage` (`src/index.ts`); `defaultResizeConfig` (`src/config/resize.ts`); `planRules`, `planVariants` (`src/plan.ts`); `Catalog` (`src/catalog.ts`); `fakeMedia` (`src/testHelpers/fakes.ts`).

**Decision (what the bench does; the rule is D5):**
- **Setup.** `sharp.cache(false)`. The source is a 6000×4000 photo-like JPEG at quality 90, generated in memory from a fixed seed (sine patterns plus noise, 3 channels). The sizes are `[{ fit: true }, { width: 620 }, { width: 300, height: 300 }]` and the encoders `defaultResizeConfig.encode.formats`. The gate formats are `['jpeg', 'webp']`; the record-only set adds `'avif'`. Concurrency is 4 in every path; `--single-thread` sets `sharp.concurrency(1)` and concurrency 1 everywhere.
- **The paths:**
  1. `oldPerVariant()` copies today's loop: one `sharp(buf, { failOn: 'none', sequentialRead: true, limitInputPixels, pages: 1 })`, then `clone().rotate().resize(…).toColorspace('srgb')` per variant (sharpened as configured), `toFormat`, `timeout`, `toBuffer`.
  2. `oldOncePerSize()` takes its sizes from `planVariants(info, new Catalog({ config }).expand(sizes, formats, scope), planRules(config, scope, {}))` with the source's `SourceInfo`, so they are path 3's. Per size it runs `sharp(buf, { failOn: 'none', sequentialRead: true, limitInputPixels, pages: 1 }).rotate().resize(width, height, { fit: mode === 'cover' ? 'cover' : 'fill', position: 'center' }).toColorspace('srgb')`, `.sharpen()` when the plan sharpens, `.raw({ depth: 'uchar' })`, and encodes each format from those pixels with `toFormat(format, encoder options)`.
  3. `newPath()` calls `resizer.generate({ media: { id: 'bench', original: { storageRef: 'src', format: 'jpeg' } }, sizes, formats, persist: false })` on a `Resizer` with in-memory storage.
  - The A/A control 2′ runs `oldOncePerSize()` a second time, as its own entry in the round.
- **Rounds.** One warm-up round is discarded. Then `rounds` rounds: argument 1, default 9, and a smaller value is raised to 9. Each round runs 1, 2, 2′ and 3 with the order rotating, and records each run's wall time (`performance.now()`) and CPU time (`process.cpuUsage()`, user + system).
- **Ratios and verdict.** Per round `r = 3 / 2` and `a = 2′ / 2`, for wall and for CPU. The verdict follows D5, in this order: `INCONCLUSIVE` (exit code 2, printing "rerun on a quieter machine") when the A/A spread (`floor(n / 4)` rounds dropped at each end of the sorted A/A ratios) exceeds 0.05, else `PASS` (exit code 0), else `FAIL` (exit code 1). Set `process.exitCode`; do not call `process.exit()`.
- **Record only.**
  - The AVIF set: 3 more rounds of paths 1, 2 and 3 with `['jpeg', 'webp', 'avif']`; medians printed, no verdict.
  - Peak RSS: for paths 1, 2, 3 and "3 with one `beforeStep` that returns its input", the bench spawns itself (`process.execPath`, `[...process.execArgv, import.meta.filename, '--rss=<path>']`). The child runs that path twice on the gate set and prints `JSON.stringify({ maxRSS: process.resourceUsage().maxRSS })` (KiB); the parent prints MB.
- **Output.** The Node version, CPU model × count, sharp and libvips versions, `os.loadavg()` before and after, and the flags. Then per path the median wall and CPU times; the median `r` and the A/A spread for wall and CPU; the verdict; the AVIF medians; the peak RSS table; and the line `spec reading (another machine): 3535 ms for 3 sizes × 3 formats`.

- [ ] **Step 1: Write the bench** as decided.
- [ ] **Step 2: Run it.** Run: `node --experimental-strip-types bench/renderOnce.ts`. Expected: `PASS`, exit code 0.
  - On `INCONCLUSIVE` (exit code 2), wait for a quieter machine and run again, at most three times; if it stays inconclusive, report the numbers.
  - On `FAIL`, stop and report the numbers; do not tune the path to pass.
- [ ] **Step 3: Record** the printed output (machine, load average, medians, ratios, A/A spread, verdict, AVIF medians, peak RSS) in the task report.
- [ ] **Step 4: Run the checks.** Run: `npm run types:check && npm run check && npm test`. Expected: PASS. `npm test` does not run the bench.
- [ ] **Step 5: Commit.** `git add bench/renderOnce.ts && git commit -m "chore: benchmark the render path against the per-variant and once-per-size paths"`

### Task 10: Docs: README, AGENTS.md, CHANGELOG, host adoption and the docs site

**Files:**
- Modify: `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/host-adoption.md`.
- Modify: `/Users/andrey/Work/framework-documenation-github/docs/12-resize.md`.

Everything host-visible from the Global Constraints:
- the `decoders` option, `SourceDecoder` and the type exports;
- the `BeforeStep` signature (a `Raster` in, a `Raster` out), the helpers `rasterToSharp` and `sharpToRaster`, the reason in one sentence, `meta.scale` and what coordinates refer to;
- how an old `Buffer` step fails now;
- what `variantSteps` receive;
- animation and `beforeSteps`;
- the memory a worker holds;
- decode failures and `RESIZE_SOURCE_DECODE_FAILED`;
- how the worker uses `original.format`;
- the five new codes, and the changed meaning of `RESIZE_ORIGINAL_FORMAT_UNSUPPORTED`;
- the one-pixel note.

- [ ] **Step 1: Update README.md.**
  - **"Package exports".** Add `SourceDecoder` to the contracts, and `rasterToSharp` / `sharpToRaster` to the main-entry functions.
  - **The pipeline reference.** A `beforeStep` is `(raster, { media, source, scale, ctx }) => Raster`: it receives the decoded first frame as raw 8-bit sRGB pixels and returns pixels, because the engine is replaceable and host steps see pixels, not a library object. A Sharp-based step stays one line: `async (r) => sharpToRaster(rasterToSharp(r).blur(5))`. A step that resolves with anything else is `RESIZE_PIPELINE_STEP_INVALID`. `variantSteps` keep a Sharp instance over each size's pixels.
  - **"Drivers".** Add a **Decoders** paragraph after "Custom drivers":
    - `new Resizer({ decoders: [new PdfDecoder()] })`, asked before the built-in Sharp and SVG decoders;
    - the contract: `formats`, `inspect` (identify and measure, never render; refuse other formats with `RESIZE_SOURCE_FORMAT_UNSUPPORTED`), `render` (an upright 8-bit raster, colour-converted to sRGB with the embedded profile and carrying no profile, at least the box where the decoder's limits allow; the renderer resizes to each exact size either way), and optional `verify()`;
    - the choice: probed at upload. In the worker the stored `original.format` picks the decoder to try first; a format no decoder lists, or one whose decoder refuses the bytes, is logged as a warning and the bytes are probed. `RESIZE_DECODER_MISSING`; `RESIZE_DECODER_INVALID`;
    - `upload.formats` must list the decoder's format, and `original.format` should be the decoder's id (`jpeg`, not `jpg` or `image/jpeg`).
  - **"Config reference".**
    - The `upload.formats` row: "accepted originals; a decoder must identify the format".
    - The `animated` row: "for a pipeline without `beforeSteps` or `variantSteps`".
  - **"Operations".**
    - The `retryable: false` list gains `RESIZE_SOURCE_FORMAT_UNSUPPORTED`; "five codes" becomes "six".
    - "the source and SVG checks, the SVG render" becomes "the decoder's checks and render".
    - Add the sentence: a source that cannot be decoded fails the task with the decoder's error, or with the retryable `RESIZE_SOURCE_DECODE_FAILED` when that error is not a `ResizeError` (Sharp's own, for example).
    - Add a memory line: a worker holds the decoded source as raw pixels. With `beforeSteps` the peak is about 2 × width × height × 4 bytes (up to 400 MB at the default `limits.sourcePixels`); an animation holds frames × box × channels; size worker containers for `limits.sourcePixels`.
    - Add: the pixel limit after `beforeSteps` is checked on the dimensions of the raster a step returned, so a step that grows the image has already allocated it at its full size when it is rejected (`RESIZE_SOURCE_TOO_LARGE`). Steps are host code.
  - **"Development".** Add one line on `node --experimental-strip-types bench/renderOnce.ts`.
- [ ] **Step 2: Update AGENTS.md.**
  - **Step 3 of Integrate.** The options list gains `decoders`. The custom-driver sentence names `SourceDecoder` and gives its contract in one sentence.
  - **"Use".**
    - "The format and dimensions come from `sharp().metadata()`" becomes "… from the decoders' `inspect` (Sharp's metadata for raster images and SVG)".
    - "`beforeSteps` receive that PNG" becomes "`beforeSteps` receive the rendered pixels as a `Raster`".
    - The "Pipelines:" line: `beforeSteps` run once on the decoded first frame, as a `Raster` in and a `Raster` out (`async (r) => sharpToRaster(rasterToSharp(r).blur(5))` wraps a Sharp step; host steps see pixels, not a library object, so the engine stays replaceable); `variantSteps` run on each size's pixels as a Sharp instance, before encode. Below it, a two-line `ts` snippet: `import { rasterToSharp, sharpToRaster } from '@adaptivestone/framework-module-resize';` and `// beforeSteps: [async (r) => sharpToRaster(rasterToSharp(r).blur(5))]`, so `src/agentsDoc.test.ts` ('every value imported from the main entry in snippets is a real export') checks both names.
  - **Rules.**
    - The `uploadOriginal()` exception becomes "the decoders' `inspect()`".
    - Add a rule: a `beforeStep` receives and returns a one-frame `Raster`, never a Sharp object or a `Buffer`; wrap Sharp work with `rasterToSharp` / `sharpToRaster`. For a raster source it sees the upright original at its own size; for a vector source the pixels can be larger, so multiply coordinates stored in the source's units by `meta.scale`.
    - Add a rule: `original.format` should be the decoder's id (`jpeg`, `png`, `svg`, …); a mismatch is logged and the bytes are probed.
  - **"Errors".** Add: a source that cannot be decoded is a `ResizeMediaError` (`RESIZE_SOURCE_DECODE_FAILED`, or the decoder's own code), so the catch example still routes it to `badRequest`.
  - **Troubleshooting.** Add rows:
    - `RESIZE_DECODER_MISSING`: no decoder in this process lists the stored format and none reads the bytes. Pass the decoder in `decoders` in every process, or fix an `original.format` that holds an alias of unreadable bytes;
    - `RESIZE_SOURCE_FORMAT_UNSUPPORTED`: every decoder refused the bytes (dead-lettered at once);
    - the warning "is stored as '…' but its bytes are '…'": `original.format` holds an alias, a MIME type or a wrong format; the preview renders, fix the record;
    - `RESIZE_SOURCE_DECODE_FAILED`: Sharp (or a host decoder) could not decode the source; the cause says why; retried, then dead-lettered;
    - `RESIZE_DECODER_INVALID`: a `decoders` entry is not a decoder, or a decoder broke the contract;
    - `RESIZE_PIPELINE_STEP_INVALID`: a `beforeStep` resolved with something that is not a one-frame `Raster` (a `Buffer`, a Sharp instance, a raster whose `data` length does not match its size), or `sharpToRaster` got a multi-page image — return `sharpToRaster(…)`;
    - Sharp's `Input file is missing` from a `beforeStep`: an old step that still calls `sharp(buf)` on its first argument, which is now a `Raster` — rewrite it as `async (r) => sharpToRaster(rasterToSharp(r)…)`.
- [ ] **Step 3: Update CHANGELOG.md** under `# 0.3.0`.
  - **Breaking changes.**
    - `BeforeStep` takes and returns a `Raster` (the decoded first frame, raw 8-bit sRGB), with `meta.source` and `meta.scale`; the engine is replaceable, so host steps see pixels, not a library object. Migration: `async (buf) => sharp(buf).blur(5).toBuffer()` becomes `async (r) => sharpToRaster(rasterToSharp(r).blur(5))`, with both helpers imported from the main entry. An old step fails inside its own `sharp(buf)` call, because Sharp reads the `Raster` object as options: it rejects with Sharp's plain `Error` "Input file is missing" (retried, then dead-lettered; thrown as-is by eager `generate()`), not with `RESIZE_PIPELINE_STEP_INVALID`, which a step gets when it resolves with something that is not a one-frame `Raster`.
    - `variantSteps` receive the sized pixels: `metadata()` reports the preview, a step's `resize()` resizes the preview, and operations Sharp used to apply before its resize (such as `trim()`) now apply to the preview.
    - Animation needs a pipeline without `beforeSteps`.
    - A decode failure fails the task, or `generate()`, with the decoder's error, or with `RESIZE_SOURCE_DECODE_FAILED`.
    - The worker reads `original.format` to pick the decoder to try first; a mismatch is logged and probed.
    - The SVG sentence "`beforeSteps` receive that PNG" is replaced.
    - `RESIZE_ORIGINAL_FORMAT_UNSUPPORTED` has its new meaning.
    - The one-pixel note, and the memory a worker holds with `beforeSteps`.
  - **Features.** `SourceDecoder`, the `decoders` option, `rasterToSharp` / `sharpToRaster`, `meta.scale` and the new codes.
  - **Internal.**
    - One decode per task, at the largest box, and one resize per size.
    - `#generatePreviews` is replaced by `planVariants` / `renderSize` / `encodeVariant` / `PreviewRecorder`.
    - The benchmark.
- [ ] **Step 4: Update `docs/host-adoption.md`.** In "Other changes a host must make for 0.3.0":
  - replace the "SVG `beforeSteps` now receive the rendered PNG" item with the new `BeforeStep` (all sources, a `Raster` in and out), its one-line migration through `rasterToSharp` / `sharpToRaster`, how an old step fails (Sharp's "Input file is missing") and `meta.scale`;
  - add the `variantSteps` and animation notes;
  - next to the media mapping advice (lines 12-14): `original.format` should be the decoder's id (`jpeg`, `png`, `svg`, …; not `jpg` or a MIME type). The worker tries that decoder first; a value no decoder lists, or one whose decoder refuses the bytes, is logged as a warning and the bytes are probed, so a legacy record with a guessed format still renders. Fix the record to silence the warning.
- [ ] **Step 5: Update the docs site.**
  - `cd /Users/andrey/Work/framework-documenation-github` (never `git -C`); the branch `docs/s3-decoder` is already checked out.
  - In `docs/12-resize.md`:
    - line 181: `beforeSteps` receive the rendered pixels as a `Raster`;
    - the pipeline example near line 390: a `beforeSteps` entry in the new form, `async (r) => sharpToRaster(rasterToSharp(r).blur(5))`, with one sentence on why (the engine is replaceable, so a step sees pixels, not a library object) and one on coordinates: for a raster source the step sees the upright original at its own size; for a vector source the pixels can be larger, so multiply coordinates by `meta.scale`;
    - "Drivers" near line 427: a short **Decoders** paragraph linking the README reference, with the `original.format` advice;
    - line 595: "the source checks and the SVG render" becomes "the decoder's checks and render";
    - the operations table: rows for `RESIZE_DECODER_MISSING`, `RESIZE_SOURCE_FORMAT_UNSUPPORTED`, `RESIZE_SOURCE_DECODE_FAILED`, `RESIZE_DECODER_INVALID` and `RESIZE_PIPELINE_STEP_INVALID`, as in AGENTS.md.
  - Keep the guide on the docs site and the reference in README.
  - Run `npx docusaurus build`. Expected: success (do not run `generate-llm-context`).
  - `git commit -am "docs(resize): decoders and the new beforeSteps"`, then return to the worktree.
- [ ] **Step 6: Run everything to verify it passes.** Run: `node --experimental-strip-types --test src/agentsDoc.test.ts && npm run types:check && npm run check && npm test && npm run build && npm run smoke`. Expected: PASS, with every snippet import in AGENTS.md a real export (`SourceDecoder`, `rasterToSharp` and `sharpToRaster` included).
- [ ] **Step 7: Commit.** `git add README.md AGENTS.md CHANGELOG.md docs/host-adoption.md && git commit -m "docs: decoders, beforeSteps on a Raster, and the new codes"`

---

## Follow-ups (later phases, not in S3)

- A per-pipeline opt-in that decodes for `beforeSteps` at the box instead of the source's own size, with the steps using `meta.scale` (cheaper and smaller, but a crop step loses resolution).
- An engine port (resize and encode behind a port, `variantSteps` in the raster form) is a later phase. S3 keeps Sharp inside `decoders/sharp.ts`, `render.ts` and the raster helpers (`raster.ts`) so that port can be cut there.

## Definition of done (S3)

- **A test-only `pdf` decoder produces previews with no core change:** Task 8, `src/customDecoder.test.ts` (eager and queued), and the guard 'no shipped file names the pdf format'.
- **The SVG tests pass through `SvgDecoder`:**
  - `SvgDecoder`'s own tests: Task 2.
  - Every SVG test in `src/processor.test.ts` (Task 6) and `src/uploader.test.ts` (Task 7), with the guard 'only the SVG decoder imports the SVG helpers'.
- **3 sizes × 3 formats on a 24 MP source is not slower than the baseline:** Task 9, `bench/renderOnce.ts`, by the relative rule of D5 (paired ratios against the same round's "resize once per size" path, gated on jpeg and webp, with an A/A control). The spec's absolute reading, 3535 ms, was met in the planning run (2867 ms wall with AVIF); the task report records the new run's numbers, the AVIF set and the peak RSS per path.
- **`generatePreviews` is gone:** Task 6, the guard 'generatePreviews is gone'.
- **F4 coverage:**

  | F4 item | Task |
  |---|---|
  | The port | 1 |
  | `SharpDecoder` | 1 |
  | `SvgDecoder` | 2 |
  | `decoders`, chosen by `inspect` at upload and by stored format in the worker (first choice; probe on a mismatch) | 1, 6, 7, 8 |
  | `uploadOriginal` only calls `inspect` | 7 (`uploader.ts` leaves the sharp allowlist) |
  | `planVariants` | 3 |
  | `renderSize` once per size; per format `variantSteps → encode` | 4, 6 |
  | `beforeSteps` once on the decoded raster, as a `Raster` in and out | 4 (the helpers), 6 |
  | Nothing in these steps touches a port | 3 and 4 (the import-graph guards on `plan.ts`, `raster.ts` and `render.ts`), 6 |

- **Sharp stays replaceable:** no host step receives a Sharp object (Task 6, the `RESIZE_PIPELINE_STEP_INVALID` cases), and the guard 'only the allowed shipped files import sharp' (Task 4, final list after Task 7) holds the allowlist of the Global Constraints.

- **F5 coverage.** The `Uploader` depends on storage, decoders and config, and the `Processor` adds decoders (Tasks 6 and 7). Metrics wait for S5.
- **Gates and docs.** `npm test`, `npm run types:check`, `npm run check`, `npm run build` and `npm run smoke` pass. README, AGENTS.md, CHANGELOG, `docs/host-adoption.md` and the docs-site page describe decoders and the `beforeSteps` change (Task 10).

## Self-review notes

- **Spec coverage:** every F4 sentence maps to a task (above). The open S3 questions are D1 and D2; D2 is the owner's engine-neutral form (a `Raster` in and out, with `rasterToSharp` / `sharpToRaster`). F4's signature gains only additive fields (D13) and `meta.scale` (D2). F4 says the worker chooses the decoder "by stored format"; D8 keeps that as the first choice and adds the probe on a mismatch, which F4 does not address.
- **Step scan.** Every step names its files, its command and its expected result. Tasks 3 and 4 now run the import-graph guards in their Step 2. Task 6's rewritten EXIF tests fail before the rewrite (today's shrink-on-load path scores about 40 dB for `100w` of the upright source against the full-decode reference) and pass after it. Task 9 states the three exit codes and what to do on each. The sharp allowlist guard (Task 4) lists `processor.ts` and `uploader.ts` until Tasks 6 and 7 remove them, so every commit is green.
- **Type consistency.** `SourceInfo`, `DecodeBox`, `RenderOptions`, `Raster` and `RasterInfo` (Task 1), `IdentifiedSource.mismatch` (Task 1, logged in Task 6), `PlanRules`, `SizePlan` and `VariantPlan` (Task 3), and `straightAlpha`, `reduceToBox`, `SizedRasters`, `EncodeOptions` and `EncodedVariant` (Task 4) are used under the same names in Tasks 6–9. `BeforeStep`'s `(raster, meta) => Raster` form and `meta.scale` are the same in D2, Task 6 and Task 10. `rasterProblem`, `checkRaster`, `rasterInput`, `rasterToSharp` and `sharpToRaster` live in `src/raster.ts` (Task 4) under the same names in the file structure, D12, the Global Constraints, Task 6 and Task 10. `RESIZE_SOURCE_DECODE_FAILED` is the same in the Global Constraints, D4, D8, Task 6 and Task 10. `createDecoderSet` (Task 1) is the one constructor of the decoder list used by the Resizer and the tests.
- **Review Focus:** each of the five is a named test: 1 in Tasks 1, 4 and 6; 2 in Tasks 1, 4 and 6; 3, 4 in Task 6; 5 in Tasks 3 and 6.
- **Proportion:** the bodies left to the implementer are those the signatures and tests determine. The decisions spell out only the geometry, the decoder choice, the Processor's order, the memory steps and the benchmark rule, which the tests alone would not fix.
