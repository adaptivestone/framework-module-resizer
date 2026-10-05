// SVG → PNG in a child process with a hard time limit. librsvg renders inside one native call
// that sharp's `.timeout()` cannot interrupt: a few hundred bytes of filtered shapes can hold a
// libuv thread for minutes. The child is killed (SIGKILL) at the deadline or when the caller's
// signal aborts; the parent settles only after the process has exited, so none is left behind.
import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResizeMediaError, ResizeSetupError } from '../errors.ts';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

// How much of the child's stderr an error message carries (its end: the actual failure).
const STDERR_TAIL = 2000;

/** The host cannot start the render process at all: a setup problem, not a media one. */
function unavailable(detail: string, cause?: unknown): ResizeSetupError {
  return new ResizeSetupError(
    `resize: SVG rendering is unavailable: ${detail}. SVG originals are rendered in a child process: the host must allow child processes (under Node's permission model, --allow-child-process) and ship svgRasterChild.js next to svgRaster.js`,
    { code: 'RESIZE_SVG_RENDER_UNAVAILABLE', cause },
  );
}

/**
 * The child script next to `moduleUrl` (this module by default): `src/*.ts` under type stripping
 * (tests), `dist/*.js` once built (hosts). Throws RESIZE_SVG_RENDER_UNAVAILABLE when it is missing.
 */
export function svgRasterChildPath(
  moduleUrl: string = import.meta.url,
): string {
  const path = fileURLToPath(
    new URL(`./svgRasterChild${extname(fileURLToPath(moduleUrl))}`, moduleUrl),
  );
  if (!existsSync(path)) {
    throw unavailable(`the child script ${path} is missing`);
  }
  return path;
}

// Resolved on the first render, not at import: importing the package must not touch the disk.
let childScript: string | undefined;

export interface SvgRasterOptions {
  /** Render density in dpi; 72 renders the SVG at its own size. */
  density: number;
  limitInputPixels: number;
  /** Kill the render after this long. */
  timeoutMs: number;
  /** Kill the render when this aborts (the task's lease was lost, the worker stops). */
  signal?: AbortSignal;
  mediaId?: string;
}

/** Render `svg` to a lossless PNG at `density`, in a child process with a hard time limit. */
export function rasterizeSvg(
  svg: Buffer,
  { density, limitInputPixels, timeoutMs, signal, mediaId }: SvgRasterOptions,
): Promise<Buffer> {
  const forMedia = mediaId === undefined ? '' : ` for media ${mediaId}`;
  const failed = (detail: string, cause?: unknown) =>
    new ResizeMediaError(`resize: SVG rendering failed${forMedia}: ${detail}`, {
      mediaId,
      code: 'RESIZE_SVG_RENDER_FAILED',
      cause,
    });
  if (signal?.aborted) {
    return Promise.reject(
      failed(
        'aborted before it started (the abort signal fired)',
        signal.reason,
      ),
    );
  }

  return new Promise((resolve, reject) => {
    let child: childProcess.ChildProcess;
    try {
      childScript ??= svgRasterChildPath();
      // No shell: the node binary itself, with the child script and its options as arguments.
      // The PNG comes back on fd 3, a pipe of its own: stdout is discarded, so nothing a host
      // preload (NODE_OPTIONS --require/--import, inherited on purpose) prints can corrupt it.
      child = childProcess.spawn(
        process.execPath,
        [childScript, JSON.stringify({ density, limitInputPixels, timeoutMs })],
        { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      // Node's permission model throws synchronously without --allow-child-process.
      reject(
        err instanceof ResizeSetupError
          ? err
          : unavailable(
              `the render process could not start (${err instanceof Error ? err.message : String(err)})`,
              err,
            ),
      );
      return;
    }
    const png: Buffer[] = [];
    let stderr = '';
    let killedFor: 'timeout' | 'abort' | undefined;
    let settled = false;

    const kill = (reason: 'timeout' | 'abort') => {
      if (killedFor === undefined) {
        killedFor = reason;
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    const onAbort = () => kill('abort');
    signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (error: Error | undefined, result?: Buffer) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        reject(error);
      } else {
        resolve(result as Buffer);
      }
    };

    child.stdio[3]?.on('data', (chunk: Buffer) => png.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    // A child that dies early closes its pipes (EPIPE); its exit status reports why.
    child.stdin?.on('error', () => {});
    child.stdio[3]?.on('error', () => {});
    child.on('error', (err) => {
      // The process could not start at all (ENOENT, EACCES): 'close' may never follow.
      if (child.pid === undefined) {
        settle(
          unavailable(
            `the render process could not start (${err.message})`,
            err,
          ),
        );
      }
    });
    // 'close' comes after the process has exited and its pipes are drained.
    child.on('close', (code, exitSignal) => {
      if (killedFor === 'timeout') {
        settle(
          new ResizeMediaError(
            `resize: SVG rendering${forMedia} exceeded limits.processingTimeoutSeconds (${timeoutMs / 1000}s) — the render process was killed`,
            { mediaId, code: 'RESIZE_SVG_RENDER_TIMEOUT' },
          ),
        );
        return;
      }
      if (killedFor === 'abort') {
        settle(
          failed(
            'the abort signal fired; the render process was killed',
            signal?.reason,
          ),
        );
        return;
      }
      if (code !== 0) {
        const status =
          code === null ? `signal ${exitSignal}` : `exit code ${code}`;
        settle(failed(`${status}: ${stderr.trim() || 'no error output'}`));
        return;
      }
      const output = Buffer.concat(png);
      if (
        output.length <= PNG_SIGNATURE.length ||
        !output.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
      ) {
        settle(failed('the render process produced no PNG'));
        return;
      }
      settle(undefined, output);
    });

    child.stdin?.end(svg);
  });
}
