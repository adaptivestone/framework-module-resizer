// SVG rasterization in a child process: output, hard time limit, abort, failures.
import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, mock, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { ResizeMediaError, ResizeSetupError } from '../errors.ts';
import { rasterizeSvg, svgRasterChildPath } from './svgRaster.ts';

const realSpawn = childProcess.spawn;

const isUnavailable = (err: unknown) =>
  err instanceof ResizeSetupError &&
  err.code === 'RESIZE_SVG_RENDER_UNAVAILABLE' &&
  /child process/.test(err.message) &&
  /svgRasterChild/.test(err.message);

// Six turbulence-filtered rects: librsvg needs more than 10 s for this 488-byte SVG, inside one
// native call that sharp's `.timeout()` cannot interrupt.
const heavySvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><filter id="f" x="0" y="0" width="1" height="1"><feTurbulence baseFrequency="0.02" numOctaves="10"/></filter>${'<rect width="100%" height="100%" filter="url(#f)"/>'.repeat(6)}</svg>`,
);

const redSvg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20" fill="red"/></svg>',
);

const options = { limitInputPixels: 268402689, timeoutMs: 10_000 };

/** True while a process with `pid` exists (signal 0 only checks). */
function isRunning(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnSpy() {
  return mock.method(childProcess, 'spawn');
}

afterEach(() => {
  mock.restoreAll();
});

describe('rasterizeSvg', () => {
  test('renders a PNG at the requested density', async () => {
    const png = await rasterizeSvg(redSvg, { ...options, density: 144 });
    const meta = await sharp(png).metadata();
    assert.equal(meta.format, 'png');
    assert.deepEqual([meta.width, meta.height], [60, 40]);
  });

  test('runs node itself, without a shell, with its stdout discarded', async () => {
    const spawn = spawnSpy();
    await rasterizeSvg(redSvg, { ...options, density: 72 });
    assert.equal(spawn.mock.callCount(), 1);
    const [command, , spawnOptions] = spawn.mock.calls[0].arguments as [
      string,
      string[],
      { shell?: unknown; stdio?: unknown[] } | undefined,
    ];
    assert.equal(command, process.execPath);
    assert.ok(!spawnOptions?.shell);
    assert.equal(spawnOptions?.stdio?.[1], 'ignore');
  });

  test('a preload that prints to stdout cannot corrupt the PNG', async (t) => {
    // NODE_OPTIONS is inherited on purpose (Yarn PnP and loaders need it): the PNG travels on
    // its own pipe, so whatever a preload prints cannot reach it.
    const dir = await mkdtemp(join(tmpdir(), 'resize-preload-'));
    const preload = join(dir, 'pre.cjs');
    await writeFile(preload, "console.log('hello from a preload');\n");
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--require "${preload}"`;
    t.after(async () => {
      if (previous === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = previous;
      }
      await rm(dir, { recursive: true, force: true });
    });
    const png = await rasterizeSvg(redSvg, { ...options, density: 72 });
    assert.deepEqual(
      [(await sharp(png).metadata()).width, png.length > 0],
      [30, true],
    );
  });

  test('a spawn that throws (permission model) is RESIZE_SVG_RENDER_UNAVAILABLE', async () => {
    const denied = Object.assign(new Error('Access to this API is denied'), {
      code: 'ERR_ACCESS_DENIED',
    });
    mock.method(childProcess, 'spawn', () => {
      throw denied;
    });
    await assert.rejects(
      () => rasterizeSvg(redSvg, { ...options, density: 72 }),
      (err: unknown) => isUnavailable(err) && (err as Error).cause === denied,
    );
  });

  test('a process that cannot start (ENOENT) is RESIZE_SVG_RENDER_UNAVAILABLE', async () => {
    mock.method(
      childProcess,
      'spawn',
      (_command: string, args: string[], spawnOptions: object) =>
        realSpawn('/nonexistent/node-binary', args, spawnOptions),
    );
    await assert.rejects(
      () => rasterizeSvg(redSvg, { ...options, density: 72 }),
      isUnavailable,
    );
  });

  test('a missing child script is RESIZE_SVG_RENDER_UNAVAILABLE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'resize-nochild-'));
    try {
      assert.throws(
        () => svgRasterChildPath(pathToFileURL(join(dir, 'svgRaster.js')).href),
        isUnavailable,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // Next to this module, the child script is found (a .ts sibling under type stripping).
    assert.match(svgRasterChildPath(), /svgRasterChild\.ts$/);
  });

  test('a render over the time limit is killed and fails with RESIZE_SVG_RENDER_TIMEOUT', {
    timeout: 8000,
  }, async () => {
    const spawn = spawnSpy();
    const started = Date.now();
    await assert.rejects(
      () =>
        rasterizeSvg(heavySvg, {
          ...options,
          density: 72,
          timeoutMs: 1000,
          mediaId: 'm1',
        }),
      (err: unknown) =>
        err instanceof ResizeMediaError &&
        err.code === 'RESIZE_SVG_RENDER_TIMEOUT' &&
        err.mediaId === 'm1',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `settled after ${elapsed} ms`);
    const child = spawn.mock.calls[0].result as ChildProcess;
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(isRunning(child.pid), false);
  });

  test('an abort signal kills the render', { timeout: 8000 }, async () => {
    const spawn = spawnSpy();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('lease lost')), 300);
    await assert.rejects(
      () =>
        rasterizeSvg(heavySvg, {
          ...options,
          density: 72,
          signal: controller.signal,
        }),
      (err: unknown) =>
        err instanceof ResizeMediaError &&
        err.code === 'RESIZE_SVG_RENDER_FAILED' &&
        /abort/i.test(err.message),
    );
    const child = spawn.mock.calls[0].result as ChildProcess;
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(isRunning(child.pid), false);
  });

  test('an already aborted signal starts no process', async () => {
    const spawn = spawnSpy();
    await assert.rejects(
      () =>
        rasterizeSvg(redSvg, {
          ...options,
          density: 72,
          signal: AbortSignal.abort(),
        }),
      (err: unknown) =>
        err instanceof ResizeMediaError &&
        err.code === 'RESIZE_SVG_RENDER_FAILED',
    );
    assert.equal(spawn.mock.callCount(), 0);
  });

  test('a render error fails with RESIZE_SVG_RENDER_FAILED and the end of stderr', async () => {
    await assert.rejects(
      () =>
        rasterizeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"'), {
          ...options,
          density: 72,
        }),
      (err: unknown) =>
        err instanceof ResizeMediaError &&
        err.code === 'RESIZE_SVG_RENDER_FAILED' &&
        /exit code 1/.test(err.message) &&
        /svg|xml|input|unsupported/i.test(err.message),
    );
  });

  test('the raster obeys limitInputPixels', async () => {
    await assert.rejects(
      () =>
        rasterizeSvg(redSvg, {
          ...options,
          density: 720,
          limitInputPixels: 1000,
        }),
      (err: unknown) =>
        err instanceof ResizeMediaError &&
        err.code === 'RESIZE_SVG_RENDER_FAILED' &&
        /pixel limit/i.test(err.message),
    );
  });
});
