// A repeatable benchmark of the render path, run by hand:
//   node --experimental-strip-types bench/renderOnce.ts [rounds] [--single-thread]
// It compares three ways of making 3 sizes × the gate formats from one 24 MP JPEG:
//   1. a copy of the earlier per-variant loop (one decode, `clone()` per variant), for information;
//   2. "resize once per size": one decode and resize per size, then each format encoded from the
//      raw pixels, with the sizes taken from the same plan the new path uses;
//   3. the new path, through the real `Resizer.generate()`.
// The verdict is relative: per round, `r = 3 / 2` for wall and CPU time, with a second copy of
// path 2 as an A/A control that tells whether the machine was quiet enough to judge. AVIF and the
// peak memory of each path are printed for the record only. Exit code: 0 PASS, 1 FAIL,
// 2 INCONCLUSIVE.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import sharp, {
  type FormatEnum,
  type OutputInfo,
  type OutputOptions,
} from 'sharp';
import { Catalog } from '../src/catalog.ts';
import defaultResizeConfig from '../src/config/resize.ts';
import type { ResizeStorage } from '../src/contracts/storage.ts';
import { runBounded } from '../src/helpers/concurrency.ts';
import { calculateResizedDimensions, coverDimensions } from '../src/images.ts';
import { planRules, planVariants, type SizePlan } from '../src/plan.ts';
import { Resizer } from '../src/resizer.ts';
import { fakeMedia } from '../src/testHelpers/fakes.ts';
import type {
  PreviewFormat,
  PreviewScope,
  ResizeConfig,
  SizeInput,
} from '../src/types.d.ts';

const SOURCE_WIDTH = 6000;
const SOURCE_HEIGHT = 4000;
const SIZES: SizeInput[] = [
  { fit: true },
  { width: 620 },
  { width: 300, height: 300 },
];
const GATE_FORMATS: PreviewFormat[] = ['jpeg', 'webp'];
const AVIF_FORMATS: PreviewFormat[] = ['jpeg', 'webp', 'avif'];
const MIN_ROUNDS = 9;
const AVIF_ROUNDS = 3;
const MAX_RATIO = 1.05;
const MAX_AA_SPREAD = 0.05;
const SCOPE: PreviewScope = { resizer: 'default', pipeline: 'default' };

const args = process.argv.slice(2);
const singleThread = args.includes('--single-thread');
const rssArg = args.find((a) => a.startsWith('--rss='));
const roundsArg = args.find((a) => !a.startsWith('--'));
const parsedRounds = roundsArg === undefined ? MIN_ROUNDS : Number(roundsArg);
const rounds =
  Number.isInteger(parsedRounds) && parsedRounds > MIN_ROUNDS
    ? parsedRounds
    : MIN_ROUNDS;
const concurrency = singleThread ? 1 : 4;

sharp.cache(false);
if (singleThread) {
  sharp.concurrency(1);
}

const config: ResizeConfig = { ...defaultResizeConfig, concurrency };
const { inputPixels: limitInputPixels, processingTimeoutSeconds } =
  config.limits;

/** A deterministic PRNG (mulberry32), so every run and every child gets the same source. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A photo-like 6000×4000 JPEG at quality 90: sine patterns plus noise, 3 channels. */
async function makeSource(): Promise<Buffer> {
  const random = seeded(20261028);
  const pixels = Buffer.alloc(SOURCE_WIDTH * SOURCE_HEIGHT * 3);
  let i = 0;
  for (let y = 0; y < SOURCE_HEIGHT; y++) {
    for (let x = 0; x < SOURCE_WIDTH; x++) {
      const base =
        Math.sin(x / 37) * Math.cos(y / 53) * 60 +
        Math.sin((x + y) / 211) * 40 +
        Math.sin(Math.hypot(x - 3000, y - 2000) / 97) * 30;
      for (let c = 0; c < 3; c++) {
        const v = 128 + base + Math.sin((x * (c + 1)) / 401) * 25;
        pixels[i++] = Math.max(
          0,
          Math.min(255, Math.round(v + (random() - 0.5) * 24)),
        );
      }
    }
  }
  return sharp(pixels, {
    raw: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, channels: 3 },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

const encodeOptions = (format: PreviewFormat): OutputOptions =>
  (config.encode.formats[format] ?? {}) as OutputOptions;

/** Path 1: the earlier loop, one shared decode cloned per variant. */
async function oldPerVariant(
  buf: Buffer,
  formats: PreviewFormat[],
): Promise<number> {
  const catalog = new Catalog({ config });
  const variants = catalog.expand(SIZES, formats, SCOPE);
  const base = sharp(buf, {
    failOn: 'none',
    sequentialRead: true,
    limitInputPixels,
    pages: 1,
  });
  let bytes = 0;
  await runBounded(variants, concurrency, undefined, async (v) => {
    const { width, height } = v.fit
      ? calculateResizedDimensions(
          SOURCE_WIDTH,
          SOURCE_HEIGHT,
          undefined,
          undefined,
          true,
          config.maxSize,
        )
      : coverDimensions(
          SOURCE_WIDTH,
          SOURCE_HEIGHT,
          v.requestedWidth,
          v.requestedHeight,
          config.limits.resultDimension,
        );
    let img = base
      .clone()
      .rotate()
      .resize(
        width,
        height,
        v.fit
          ? { fit: 'inside', withoutEnlargement: true }
          : { fit: 'cover', position: 'center' },
      )
      .toColorspace('srgb');
    const s = config.encode.sharpen;
    if (s && (v.fit ? s.fit : s.cover)) {
      img = img.sharpen();
    }
    const data = await img
      .toFormat(v.format as keyof FormatEnum, encodeOptions(v.format))
      .timeout({ seconds: processingTimeoutSeconds })
      .toBuffer();
    bytes += data.length;
  });
  return bytes;
}

/** Path 2: one decode and resize per size (the new path's own plan), each format from raw pixels. */
async function oldOncePerSize(
  buf: Buffer,
  formats: PreviewFormat[],
): Promise<number> {
  const meta = await sharp(buf).metadata();
  const info = {
    format: 'jpeg',
    contentType: 'image/jpeg',
    width: meta.width,
    height: meta.height,
  };
  const plans = planVariants(
    info,
    new Catalog({ config }).expand(SIZES, formats, SCOPE),
    planRules(config, SCOPE, {}),
  );
  const rendered = new Map<
    string,
    Promise<{ data: Buffer; info: OutputInfo }>
  >();
  const renderSize = (size: SizePlan) => {
    let pending = rendered.get(size.key);
    if (pending === undefined) {
      let img = sharp(buf, {
        failOn: 'none',
        sequentialRead: true,
        limitInputPixels,
        pages: 1,
      })
        .rotate()
        .resize(size.width, size.height, {
          fit: size.mode === 'cover' ? 'cover' : 'fill',
          position: 'center',
        })
        .toColorspace('srgb');
      if (size.sharpen) {
        img = img.sharpen();
      }
      pending = img
        .raw({ depth: 'uchar' })
        .timeout({ seconds: processingTimeoutSeconds })
        .toBuffer({ resolveWithObject: true });
      rendered.set(size.key, pending);
    }
    return pending;
  };
  let bytes = 0;
  await runBounded(plans, concurrency, undefined, async (plan) => {
    const raw = await renderSize(plan.size);
    const data = await sharp(raw.data, {
      raw: {
        width: raw.info.width,
        height: raw.info.height,
        channels: raw.info.channels,
      },
      limitInputPixels,
    })
      .toFormat(
        plan.variant.format as keyof FormatEnum,
        encodeOptions(plan.variant.format),
      )
      .timeout({ seconds: processingTimeoutSeconds })
      .toBuffer();
    bytes += data.length;
  });
  return bytes;
}

/** Path 3 runs on one Resizer, built once (one Resizer per name per process). */
function makeResizer(buf: Buffer): Resizer {
  const storage: ResizeStorage = {
    download: async (ref) => {
      if (ref !== 'src') {
        throw new Error(`no file ${String(ref)}`);
      }
      return buf;
    },
    // The previews are discarded: the bench measures the render, not the storage.
    upload: async ({ key }) => ({ key }),
    publicUrl: () => '/bench',
  };
  return new Resizer({
    storage,
    media: fakeMedia(),
    config,
    logger: { info() {}, warn() {}, error() {} },
    pipelines: {
      default: {},
      // The memory bound with beforeSteps: the whole source is decoded for the steps.
      unchanged: { beforeSteps: [(raster) => raster] },
    },
  });
}

async function newPath(
  resizer: Resizer,
  formats: PreviewFormat[],
  pipeline = 'default',
): Promise<number> {
  const { created, failed } = await resizer.generate({
    media: {
      id: 'bench',
      original: { storageRef: 'src', format: 'jpeg' },
      previews: [],
    },
    sizes: SIZES,
    formats,
    pipeline,
    persist: false,
  });
  if (failed > 0 || created.length !== SIZES.length * formats.length) {
    throw new Error(
      `bench: the new path made ${created.length} previews, ${failed} failed`,
    );
  }
  return created.reduce((sum, p) => sum + (p.bytes ?? 0), 0);
}

interface Timing {
  wall: number;
  cpu: number;
}

async function timed(run: () => Promise<unknown>): Promise<Timing> {
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  await run();
  const wall = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  return { wall, cpu: (cpu.user + cpu.system) / 1000 };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** The largest |a − 1| after dropping floor(n / 4) ratios at each end of the sorted list. */
const aaSpread = (ratios: number[]): number => {
  const sorted = [...ratios].sort((a, b) => a - b);
  const drop = Math.floor(sorted.length / 4);
  const kept = sorted.slice(drop, sorted.length - drop);
  return Math.max(...kept.map((a) => Math.abs(a - 1)));
};

const ms = (n: number): string => `${Math.round(n)} ms`;
const loadavg = (): string =>
  os
    .loadavg()
    .map((n) => n.toFixed(2))
    .join(' / ');

type Entry = { name: string; run: () => Promise<unknown> };

/** Runs every entry once per round, the order rotating each round; returns the timings by name. */
async function runRounds(
  entries: Entry[],
  count: number,
): Promise<Map<string, Timing[]>> {
  const timings = new Map<string, Timing[]>(entries.map((e) => [e.name, []]));
  for (let round = 0; round < count; round++) {
    for (let k = 0; k < entries.length; k++) {
      const entry = entries[(round + k) % entries.length];
      timings.get(entry.name)?.push(await timed(entry.run));
    }
  }
  return timings;
}

const RSS_PATHS = ['1', '2', '3', '3+beforeStep'] as const;

/** Child mode: run one path twice on the gate set and print the peak RSS (KiB). */
async function rssChild(path: string): Promise<void> {
  const buf = await makeSource();
  const runs: Record<string, () => Promise<unknown>> = {
    '1': () => oldPerVariant(buf, GATE_FORMATS),
    '2': () => oldOncePerSize(buf, GATE_FORMATS),
  };
  if (path === '3' || path === '3+beforeStep') {
    const resizer = makeResizer(buf);
    const pipeline = path === '3' ? 'default' : 'unchanged';
    runs[path] = () => newPath(resizer, GATE_FORMATS, pipeline);
  }
  const run = runs[path];
  if (run === undefined) {
    throw new Error(`bench: unknown --rss path ${path}`);
  }
  await run();
  await run();
  console.log(JSON.stringify({ maxRSS: process.resourceUsage().maxRSS }));
}

function measureRss(path: string): string {
  const child = spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      import.meta.filename,
      `--rss=${path}`,
      ...(singleThread ? ['--single-thread'] : []),
    ],
    { encoding: 'utf8' },
  );
  const line = child.stdout.trim().split('\n').at(-1) ?? '';
  try {
    const { maxRSS } = JSON.parse(line) as { maxRSS: number };
    return `${(maxRSS / 1024).toFixed(0)} MB`;
  } catch {
    return `failed (exit ${child.status}): ${child.stderr.trim().split('\n').at(-1) ?? ''}`;
  }
}

async function main(): Promise<void> {
  const cpus = os.cpus();
  console.log(`node ${process.version}`);
  console.log(`cpu ${cpus[0]?.model ?? 'unknown'} × ${cpus.length}`);
  console.log(`sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}`);
  console.log(`load average before: ${loadavg()}`);
  console.log(
    `flags: rounds ${rounds}, concurrency ${concurrency}${singleThread ? ', --single-thread' : ''}`,
  );

  const buf = await makeSource();
  const resizer = makeResizer(buf);
  const gate: Entry[] = [
    { name: '1', run: () => oldPerVariant(buf, GATE_FORMATS) },
    { name: '2', run: () => oldOncePerSize(buf, GATE_FORMATS) },
    { name: "2'", run: () => oldOncePerSize(buf, GATE_FORMATS) },
    { name: '3', run: () => newPath(resizer, GATE_FORMATS) },
  ];

  await runRounds(gate, 1); // warm-up, discarded
  const timings = await runRounds(gate, rounds);
  const of = (name: string): Timing[] => timings.get(name) ?? [];

  console.log(
    `\ngate set: ${SIZES.length} sizes × ${GATE_FORMATS.join(', ')}, ${rounds} rounds`,
  );
  for (const name of ['1', '2', "2'", '3']) {
    const t = of(name);
    console.log(
      `  path ${name.padEnd(2)}  wall ${ms(median(t.map((x) => x.wall)))}  cpu ${ms(median(t.map((x) => x.cpu)))}`,
    );
  }

  const results = (['wall', 'cpu'] as const).map((kind) => {
    const p2 = of('2').map((x) => x[kind]);
    const r = of('3').map((x, i) => x[kind] / p2[i]);
    const a = of("2'").map((x, i) => x[kind] / p2[i]);
    return { kind, r: median(r), spread: aaSpread(a) };
  });
  for (const { kind, r, spread } of results) {
    console.log(
      `  ${kind.padEnd(4)}  median r (3 / 2) ${r.toFixed(3)}  A/A spread ${spread.toFixed(3)}`,
    );
  }

  let verdict: string;
  if (results.some((x) => x.spread > MAX_AA_SPREAD)) {
    verdict = 'INCONCLUSIVE: rerun on a quieter machine';
    process.exitCode = 2;
  } else if (results.every((x) => x.r <= MAX_RATIO)) {
    verdict = 'PASS';
    process.exitCode = 0;
  } else {
    verdict = 'FAIL';
    process.exitCode = 1;
  }
  console.log(`verdict: ${verdict}`);

  const avif = await runRounds(
    [
      { name: '1', run: () => oldPerVariant(buf, AVIF_FORMATS) },
      { name: '2', run: () => oldOncePerSize(buf, AVIF_FORMATS) },
      { name: '3', run: () => newPath(resizer, AVIF_FORMATS) },
    ],
    AVIF_ROUNDS,
  );
  console.log(
    `\nrecord only: ${SIZES.length} sizes × ${AVIF_FORMATS.join(', ')}, ${AVIF_ROUNDS} rounds`,
  );
  for (const name of ['1', '2', '3']) {
    const t = avif.get(name) ?? [];
    console.log(
      `  path ${name.padEnd(2)}  wall ${ms(median(t.map((x) => x.wall)))}  cpu ${ms(median(t.map((x) => x.cpu)))}`,
    );
  }

  console.log('\npeak RSS (own process, the gate set run twice):');
  for (const path of RSS_PATHS) {
    console.log(`  path ${path.padEnd(13)} ${measureRss(path)}`);
  }

  console.log(`\nload average after: ${loadavg()}`);
  console.log(
    'spec reading (another machine): 3535 ms for 3 sizes × 3 formats',
  );
}

if (rssArg !== undefined) {
  await rssChild(rssArg.slice('--rss='.length));
} else {
  await main();
}
